import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import type { Entity, TechnicalGraph } from './contracts';
import { calleeName, clean, isTestPath, lineOf, propertyName, stringValue, unwrapExpression } from './application-map-ast';

/**
 * Deterministic, repository-only hints about business meaning. Nothing here is interpreted;
 * the reporting layer hands these to the LLM as evidence with file/line provenance.
 */
export interface BusinessSignals {
  schemaVersion: '1.0';
  packageInfo: { name?: string; description?: string; dependencies: string[]; capabilityHints: Array<{ dependency: string; hint: string }> };
  documents: Array<{ path: string; excerpt: string; truncated: boolean }>;
  dataModels: Array<{ name: string; fields: string[]; source: 'prisma' | 'typescript' | 'orm-entity' | 'schema-validator' | 'sql'; file: string; line: number }>;
  enums: Array<{ name: string; values: string[]; file: string; line: number }>;
  messages: Array<{ text: string; kind: 'error' | 'validation' | 'notification' | 'response'; file: string; line: number; entityId?: string }>;
  constants: Array<{ name: string; value: string; file: string; line: number; entityId?: string }>;
  testTitles: Array<{ title: string; file: string; line: number; entityIds: string[] }>;
  translations: Array<{ file: string; locale: string; entries: Array<[string, string]> }>;
  envVars: string[];
  limits: { truncated: string[] };
}

export interface CollectBusinessSignalsInput {
  projectRoot: string;
  /** Project-relative file inventory (tracked and non-ignored untracked files). */
  files: string[];
  technicalGraph: TechnicalGraph;
  readFile?: (absolutePath: string) => string | undefined;
}

const CAPABILITY_HINTS: Array<[RegExp, string]> = [
  [/^(stripe|@stripe\/|braintree|paypal|@paypal\/|adyen|square|razorpay|mollie)/, 'online payments'],
  [/^(nodemailer|@sendgrid\/|mailgun|postmark|resend|@aws-sdk\/client-ses)/, 'email notifications'],
  [/^(twilio|@vonage\/|messagebird)/, 'SMS or phone notifications'],
  [/^(next-auth|@auth\/|passport|@clerk\/|auth0|@auth0\/|firebase-admin|@supabase\/|jsonwebtoken|jose|keycloak|@okta\/)/, 'user authentication and sessions'],
  [/^(prisma|@prisma\/client|typeorm|sequelize|mongoose|drizzle-orm|knex|@mikro-orm\/|pg|mysql2|mongodb)/, 'persistent data storage'],
  [/^(bull|bullmq|agenda|node-cron|@nestjs\/schedule|pg-boss)/, 'background jobs and scheduling'],
  [/^(socket\.io|ws|@pusher\/|pusher|ably)/, 'real-time updates'],
  [/^(i18next|react-i18next|next-intl|@ngx-translate\/|vue-i18n|react-intl|@formatjs\/)/, 'multiple languages'],
  [/^(aws-sdk|@aws-sdk\/client-s3|multer|@uploadthing\/|cloudinary|@google-cloud\/storage)/, 'file uploads and storage'],
  [/^(@tanstack\/react-table|ag-grid|recharts|chart\.js|echarts|d3)/, 'data tables, charts, or reporting'],
  [/^(react-hook-form|formik|zod|yup|joi|class-validator|valibot)/, 'form and input validation'],
  [/^(@shopify\/|commercetools|medusa|@medusajs\/)/, 'e-commerce catalog and checkout'],
  [/^(mapbox|leaflet|@react-google-maps\/|@googlemaps\/)/, 'maps and location'],
  [/^(openai|@anthropic-ai\/|langchain|@langchain\/)/, 'AI-assisted features'],
  [/^(@sentry\/|launchdarkly|@launchdarkly\/|unleash|posthog|mixpanel|@segment\/)/, 'feature flags or product analytics'],
];

const DOC_BUDGET = 40_000;
const DOC_FILE_BUDGET = 8_000;
const MAX_MESSAGES = 300;
const MAX_CONSTANTS = 200;
const MAX_TEST_TITLES = 400;
const MAX_MODELS = 200;
const MAX_TRANSLATIONS = 600;

function entityAt(entities: Entity[], file: string, line: number): Entity | undefined {
  return entities.filter(entity => entity.file === file && entity.startLine <= line && entity.endLine >= line)
    .sort((a, b) => (a.endLine - a.startLine) - (b.endLine - b.startLine))[0];
}

function flatten(value: unknown, prefix: string, out: Array<[string, string]>, limit: number): void {
  if (out.length >= limit) return;
  if (typeof value === 'string') { out.push([prefix, value]); return; }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) flatten(child, prefix ? `${prefix}.${key}` : key, out, limit);
  }
}

function parsePrisma(text: string, file: string, models: BusinessSignals['dataModels'], enums: BusinessSignals['enums']): void {
  const block = /^(model|enum|type|view)\s+(\w+)\s*\{([\s\S]*?)^\}/gm;
  let match: RegExpExecArray | null;
  while ((match = block.exec(text))) {
    const line = text.slice(0, match.index).split('\n').length;
    const body = match[3]!.split('\n').map(item => item.trim()).filter(item => item && !item.startsWith('//') && !item.startsWith('@@'));
    if (match[1] === 'enum') enums.push({ name: match[2]!, values: body.map(item => item.split(/\s+/)[0]!), file, line });
    else models.push({ name: match[2]!, fields: body.map(item => item.split(/\s+/).slice(0, 2).join(' ')).slice(0, 40), source: 'prisma', file, line });
  }
}

function parseSql(text: string, file: string, models: BusinessSignals['dataModels']): void {
  const table = /create\s+table\s+(?:if\s+not\s+exists\s+)?["`]?(\w+)["`]?\s*\(([\s\S]*?)\);/gi;
  let match: RegExpExecArray | null;
  while ((match = table.exec(text)) && models.length < MAX_MODELS) {
    const line = text.slice(0, match.index).split('\n').length;
    const fields = match[2]!.split(',').map(item => item.trim().split(/\s+/).slice(0, 2).join(' ').replace(/["`]/g, ''))
      .filter(item => item && !/^(primary|foreign|constraint|unique|key|index|check)\b/i.test(item));
    models.push({ name: match[1]!, fields: fields.slice(0, 40), source: 'sql', file, line });
  }
}

export function collectBusinessSignals(input: CollectBusinessSignalsInput): BusinessSignals {
  const read = input.readFile ?? ((absolute: string) => {
    try { return fs.readFileSync(absolute, 'utf8'); } catch { return undefined; }
  });
  const entities = input.technicalGraph.entities;
  const truncated: string[] = [];
  const signals: BusinessSignals = {
    schemaVersion: '1.0',
    packageInfo: { dependencies: [], capabilityHints: [] },
    documents: [], dataModels: [], enums: [], messages: [], constants: [], testTitles: [], translations: [], envVars: [],
    limits: { truncated },
  };
  const files = [...new Set(input.files.map(file => file.replace(/\\/g, '/')))].sort();

  // Package manifests
  const dependencies = new Set<string>();
  for (const file of files.filter(item => path.posix.basename(item) === 'package.json' && !item.includes('node_modules/'))) {
    try {
      const manifest = JSON.parse(read(path.join(input.projectRoot, file)) ?? '{}');
      if (file === 'package.json') {
        if (typeof manifest.name === 'string') signals.packageInfo.name = manifest.name;
        if (typeof manifest.description === 'string') signals.packageInfo.description = manifest.description;
      }
      for (const key of ['dependencies', 'devDependencies', 'peerDependencies']) for (const name of Object.keys(manifest?.[key] ?? {})) dependencies.add(name);
    } catch { /* ignore malformed manifests */ }
  }
  signals.packageInfo.dependencies = [...dependencies].sort().slice(0, 300);
  const hints = new Map<string, string>();
  for (const dependency of dependencies) {
    const hint = CAPABILITY_HINTS.find(([pattern]) => pattern.test(dependency));
    if (hint && !hints.has(hint[1])) hints.set(hint[1], dependency);
  }
  signals.packageInfo.capabilityHints = [...hints].map(([hint, dependency]) => ({ dependency, hint }));

  // Documentation: README first, then docs folders, then other Markdown.
  const docs = files.filter(file => /\.(md|mdx|markdown|txt|rst|adoc)$/i.test(file) && !/(^|\/)(node_modules|CHANGELOG|LICENSE|\.github)\b/i.test(file) &&
    !/(^|\/)(CODE_OF_CONDUCT|CONTRIBUTING|SECURITY)\./i.test(file))
    .sort((a, b) => {
      const rank = (file: string) => /^readme\./i.test(file) ? 0 : /(^|\/)readme\./i.test(file) ? 1 : /(^|\/)(docs?|documentation|wiki|specs?|requirements)\//i.test(file) ? 2 : 3;
      return rank(a) - rank(b) || a.localeCompare(b);
    });
  let docBudget = DOC_BUDGET;
  for (const file of docs) {
    if (docBudget <= 500) { truncated.push(`documents after ${signals.documents.length} files`); break; }
    const text = read(path.join(input.projectRoot, file));
    if (!text?.trim()) continue;
    const limit = Math.min(DOC_FILE_BUDGET, docBudget);
    const excerpt = text.replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
    signals.documents.push({ path: file, excerpt: excerpt.slice(0, limit), truncated: excerpt.length > limit });
    docBudget -= Math.min(limit, excerpt.length);
  }

  // Schemas outside TypeScript
  for (const file of files) {
    if (/\.prisma$/i.test(file)) parsePrisma(read(path.join(input.projectRoot, file)) ?? '', file, signals.dataModels, signals.enums);
    else if (/\.sql$/i.test(file) && signals.dataModels.length < MAX_MODELS) parseSql(read(path.join(input.projectRoot, file)) ?? '', file, signals.dataModels);
  }

  // Translations: prefer English locale files.
  const localeFiles = files.filter(file => /\.json$/i.test(file) && /(^|\/)(locales?|i18n|lang|translations?|messages)\//i.test(file))
    .sort((a, b) => Number(!/(^|[/._-])en([/._-]|$)/i.test(a)) - Number(!/(^|[/._-])en([/._-]|$)/i.test(b)) || a.localeCompare(b));
  let translationBudget = MAX_TRANSLATIONS;
  for (const file of localeFiles) {
    if (translationBudget <= 0) { truncated.push('translations'); break; }
    try {
      const entries: Array<[string, string]> = [];
      const namespace = /(^|\/)(locales?|i18n|lang|translations?|messages)\/[^/]+\/([^/]+)\.json$/i.exec(file)?.[3];
      flatten(JSON.parse(read(path.join(input.projectRoot, file)) ?? '{}'), namespace && namespace !== 'translation' && namespace !== 'common' ? namespace : '', entries, translationBudget);
      const locale = /(?:^|[/._-])([a-z]{2}(?:[-_][A-Z]{2})?)(?:[/._-]|$)/.exec(file.replace(/\.json$/i, ''))?.[1] ?? 'unknown';
      signals.translations.push({ file, locale, entries });
      translationBudget -= entries.length;
    } catch { /* ignore */ }
  }

  // Environment variable names (never values)
  const env = new Set<string>();
  for (const file of files.filter(file => /(^|\/)\.env\.(example|sample|template|defaults)$/i.test(file))) {
    for (const line of (read(path.join(input.projectRoot, file)) ?? '').split('\n')) {
      const name = /^\s*([A-Z][A-Z0-9_]+)\s*=/.exec(line)?.[1];
      if (name) env.add(name);
    }
  }

  // TypeScript sources
  for (const file of input.technicalGraph.analyzedFiles) {
    const text = read(path.join(input.projectRoot, file));
    if (text === undefined) continue;
    const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const test = isTestPath(file);
    const suites: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isPropertyAccessExpression(node) && node.expression.getText() === 'process.env') env.add(node.name.text);
      if (!test) {
        if (ts.isEnumDeclaration(node) && signals.enums.length < MAX_MODELS) {
          signals.enums.push({ name: node.name.text, file, line: lineOf(node),
            values: node.members.map(member => {
              const value = member.initializer ? stringValue(member.initializer) : undefined;
              return value && value !== propertyName(member.name) ? `${propertyName(member.name)}=${value}` : propertyName(member.name) ?? '';
            }).filter(Boolean).slice(0, 40) });
        } else if (ts.isTypeAliasDeclaration(node) && ts.isUnionTypeNode(node.type) &&
            node.type.types.every(type => ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) && node.type.types.length >= 2) {
          signals.enums.push({ name: node.name.text, file, line: lineOf(node),
            values: node.type.types.map(type => ((type as ts.LiteralTypeNode).literal as ts.StringLiteral).text).slice(0, 40) });
        } else if ((ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isClassDeclaration(node)) && node.name &&
            signals.dataModels.length < MAX_MODELS && /^[A-Z]/.test(node.name.text)) {
          const isExported = node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
          const decoratorNames = ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []).map(decorator => calleeName(
            ts.isCallExpression(decorator.expression) ? decorator.expression.expression : decorator.expression) ?? '') : [];
          const members = ts.isInterfaceDeclaration(node) || ts.isClassDeclaration(node) ? node.members
            : ts.isTypeLiteralNode(node.type) ? node.type.members : undefined;
          const fields = (members ?? []).flatMap(member => {
            if (!(ts.isPropertySignature(member) || ts.isPropertyDeclaration(member)) || !member.name) return [];
            const name = propertyName(member.name);
            return name ? [`${name}${member.questionToken ? '?' : ''}${member.type ? `: ${member.type.getText().slice(0, 40)}` : ''}`] : [];
          });
          const isOrm = decoratorNames.some(name => /^(Entity|Table|Schema|Model|ObjectType|InputType)$/.test(name));
          const isDomainFolder = /(^|\/)(models?|entities|domain|types|schemas?|dto|dtos|contracts?|interfaces)(\/|\.)/i.test(file);
          if (fields.length >= 2 && (isOrm || (isExported && isDomainFolder))) {
            signals.dataModels.push({ name: node.name.text, fields: fields.slice(0, 40), source: isOrm ? 'orm-entity' : 'typescript', file, line: lineOf(node) });
          }
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && signals.constants.length < MAX_CONSTANTS &&
            /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$|^[A-Z]{3,}$/.test(node.name.text)) {
          const initializer = unwrapExpression(node.initializer);
          const value = ts.isNumericLiteral(initializer) || ts.isPrefixUnaryExpression(initializer) ? initializer.getText()
            : stringValue(initializer);
          if (value !== undefined && value.length <= 80 && !/(KEY|SECRET|TOKEN|PASSWORD|PRIVATE)/.test(node.name.text)) {
            const line = lineOf(node);
            signals.constants.push({ name: node.name.text, value, file, line, entityId: entityAt(entities, file, line)?.id });
          }
        } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const name = node.expression ? calleeName(node.expression) : undefined;
          const args = node.arguments ?? [];
          let kind: BusinessSignals['messages'][number]['kind'] | undefined;
          let messageArg: ts.Expression | undefined;
          if (ts.isNewExpression(node) && name && /(Error|Exception)$/.test(name)) { kind = 'error'; messageArg = args[0]; }
          else if (name && /^(toast|notify|alert|message|notification|snackbar|enqueueSnackbar|showToast|showError|showSuccess|success|warning|info)$/i.test(name) &&
              /toast|notif|snack|message|alert/i.test(node.expression.getText())) { kind = 'notification'; messageArg = args[0]; }
          else if (name && /^(min|max|length|regex|email|url|refine|matches|required|oneOf|positive|nonnegative|int|lt|lte|gt|gte|nonempty)$/.test(name)) {
            kind = 'validation';
            messageArg = args.find(argument => stringValue(argument) !== undefined && !/^[\^/]/.test(stringValue(argument)!));
            const options = args.find(argument => ts.isObjectLiteralExpression(argument)) as ts.ObjectLiteralExpression | undefined;
            const messageProperty = options?.properties.find(property => ts.isPropertyAssignment(property) && propertyName(property.name) === 'message') as ts.PropertyAssignment | undefined;
            if (messageProperty) messageArg = messageProperty.initializer;
          } else if (name === 'json' || name === 'send') {
            const body = args[0] && ts.isObjectLiteralExpression(unwrapExpression(args[0])) ? unwrapExpression(args[0]) as ts.ObjectLiteralExpression : undefined;
            const property = body?.properties.find(item => ts.isPropertyAssignment(item) && /^(message|error|detail|title)$/.test(propertyName(item.name) ?? '')) as ts.PropertyAssignment | undefined;
            if (property) { kind = 'response'; messageArg = property.initializer; }
          }
          const text = kind ? stringValue(messageArg) : undefined;
          const message = text ? clean(text, 200) : undefined;
          if (kind && message && signals.messages.length < MAX_MESSAGES && !signals.messages.some(item => item.text === message && item.file === file)) {
            const line = lineOf(node);
            signals.messages.push({ text: message, kind, file, line, entityId: entityAt(entities, file, line)?.id });
          }
        }
      }
      // Test titles are plain-English statements of expected behaviour.
      if (ts.isCallExpression(node) && signals.testTitles.length < MAX_TEST_TITLES) {
        const base = unwrapExpression(node.expression);
        const isDescribeMember = ts.isPropertyAccessExpression(base) && base.name.text === 'describe';
        const name = isDescribeMember ? 'describe' : ts.isIdentifier(base) ? base.text
          : ts.isPropertyAccessExpression(base) && ts.isIdentifier(base.expression) ? base.expression.text : undefined;
        const title = stringValue(node.arguments[0]);
        const callback = node.arguments.find(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) as ts.ArrowFunction | ts.FunctionExpression | undefined;
        if (name && title && callback && /^(describe|context|suite)$/.test(name)) {
          suites.push(title);
          ts.forEachChild(node, visit);
          suites.pop();
          return;
        }
        if (name && title && callback && /^(it|test|specify|scenario)$/.test(name)) {
          const called = new Set<string>();
          const findCalls = (child: ts.Node) => {
            if (ts.isCallExpression(child)) {
              const callee = calleeName(child.expression);
              for (const entity of entities) if (entity.name === callee && !isTestPath(entity.file)) called.add(entity.id);
            }
            ts.forEachChild(child, findCalls);
          };
          findCalls(callback.body);
          const label = clean([...suites, title].join(' › '), 240);
          if (label) signals.testTitles.push({ title: label, file, line: lineOf(node), entityIds: [...called].sort().slice(0, 10) });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  // Named test functions (e.g. `function testSubmitOrder()`) are weaker but still useful titles.
  for (const entity of entities) {
    if (!isTestPath(entity.file) || signals.testTitles.length >= MAX_TEST_TITLES) continue;
    if (signals.testTitles.some(item => item.file === entity.file && item.line >= entity.startLine && item.line <= entity.endLine)) continue;
    const words = entity.name.replace(/^test_?/i, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase().trim();
    const targets = input.technicalGraph.relations.filter(relation => relation.from === entity.id).map(relation => relation.to);
    if (words) signals.testTitles.push({ title: words, file: entity.file, line: entity.startLine, entityIds: targets });
  }
  signals.envVars = [...env].sort().slice(0, 150);
  if (signals.messages.length >= MAX_MESSAGES) truncated.push('messages');
  if (signals.constants.length >= MAX_CONSTANTS) truncated.push('constants');
  if (signals.testTitles.length >= MAX_TEST_TITLES) truncated.push('testTitles');
  return signals;
}
