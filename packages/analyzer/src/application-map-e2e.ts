import * as ts from 'typescript';
import { calleeName, clean, getProperty, lineOf, stringValue, toPath, unwrapExpression } from './application-map-ast';

export interface E2EFlow {
  title: string;
  file: string;
  line: number;
  framework: 'playwright' | 'cypress' | 'generic';
  steps: string[];
  visitedRoutes: string[];
  surfaceIds: string[];
}

const MAX_STEPS = 25;
const TEST_FUNCTIONS = new Set(['test', 'it', 'scenario', 'specify']);
const SUITE_FUNCTIONS = new Set(['describe', 'context', 'suite']);

function quote(value: string | undefined): string {
  return value === undefined ? 'the element' : `'${value}'`;
}

/** Describes a Playwright/Cypress/Testing Library locator in QA language. */
function describeTarget(expression: ts.Expression | undefined): string {
  if (!expression) return 'the element';
  const target = unwrapExpression(expression);
  if (!ts.isCallExpression(target)) return 'the element';
  const name = calleeName(target.expression);
  const [first, second] = target.arguments;
  const text = stringValue(first);
  switch (name) {
    case 'getByRole':
    case 'findByRole': {
      const options = second && ts.isObjectLiteralExpression(unwrapExpression(second)) ? unwrapExpression(second) as ts.ObjectLiteralExpression : undefined;
      const label = stringValue(options ? getProperty(options, 'name') : undefined);
      return label ? `the '${label}' ${text ?? 'element'}` : `the ${text ?? 'element'}`;
    }
    case 'getByText': case 'findByText': case 'contains': case 'getByTitle':
      return quote(text ?? stringValue(second));
    case 'getByLabel': case 'getByLabelText': case 'findByLabelText':
      return `the '${text}' field`;
    case 'getByPlaceholder': case 'getByPlaceholderText':
      return `the '${text}' field`;
    case 'getByTestId': case 'findByTestId':
      return `the element marked '${text}'`;
    case 'locator': case 'get': case '$': case 'find': case 'querySelector':
      return text ? `'${text}'` : 'the element';
    case 'first': case 'last': case 'nth': case 'filter': case 'within':
      return ts.isPropertyAccessExpression(target.expression) ? describeTarget(target.expression.expression) : 'the element';
    default:
      return 'the element';
  }
}

function receiver(call: ts.CallExpression): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.expression : undefined;
}

function isPageLike(expression: ts.Expression | undefined): boolean {
  if (!expression) return false;
  const text = unwrapExpression(expression).getText();
  return /^(page|this\.page|cy|browser|driver)$/.test(text);
}

/** Converts one statement-level expression into a readable step, or undefined. */
function describeStep(expression: ts.Expression, routes: string[]): string | undefined {
  const target = unwrapExpression(expression);
  if (!ts.isCallExpression(target)) return undefined;
  const name = calleeName(target.expression);
  const args = target.arguments;
  const on = receiver(target);
  const pageCall = isPageLike(on);
  // For `page.click(selector)` the selector is the argument; for `locator.click()` it is the receiver.
  const subject = pageCall ? (args[0] ? `'${stringValue(args[0]) ?? args[0].getText()}'` : 'the page') : describeTarget(on);
  const value = stringValue(pageCall ? args[1] : args[0]);
  switch (name) {
    case 'goto': case 'visit': case 'navigate': {
      const url = stringValue(args[0]);
      const route = url ? toPath(url) ?? url : undefined;
      if (route) routes.push(route);
      return route ? `Open ${route}` : 'Open the application';
    }
    case 'click': case 'dblclick': case 'tap':
      return `Click ${subject}`;
    case 'check': return `Tick ${subject}`;
    case 'uncheck': return `Untick ${subject}`;
    case 'hover': return `Hover over ${subject}`;
    case 'fill': case 'type': case 'pressSequentially':
      return value !== undefined ? `Enter "${value}" into ${subject}` : `Type into ${subject}`;
    case 'clear': return `Clear ${subject}`;
    case 'selectOption': case 'select':
      return value !== undefined ? `Choose "${value}" in ${subject}` : `Choose an option in ${subject}`;
    case 'press': return value !== undefined ? `Press ${value}` : undefined;
    case 'setInputFiles': case 'selectFile': case 'attachFile': return `Upload a file using ${subject}`;
    case 'should': {
      const assertion = stringValue(args[0]);
      const expected = stringValue(args[1]);
      return `Expect ${describeTarget(on)} ${assertion?.replace(/\./g, ' ') ?? 'to match'}${expected !== undefined ? ` "${expected}"` : ''}`;
    }
    default:
      break;
  }
  // expect(locator).toBeVisible() / expect(page).toHaveURL('/x')
  if (name && /^to[A-Z]/.test(name) && on) {
    let base = unwrapExpression(on);
    let negated = false;
    if (ts.isPropertyAccessExpression(base) && base.name.text === 'not') { negated = true; base = base.expression; }
    if (ts.isCallExpression(base) && calleeName(base.expression) === 'expect') {
      const subjectExpression = base.arguments[0];
      const expected = stringValue(args[0]);
      const phrase = name.replace(/^to/, '').replace(/([A-Z])/g, ' $1').trim().toLowerCase()
        .replace(/^be /, 'to be ').replace(/^have /, 'to have ').replace(/^contain /, 'to contain ').replace(/^equal$/, 'to equal');
      const described = subjectExpression && isPageLike(subjectExpression) ? 'the page' : describeTarget(subjectExpression);
      if (name === 'toHaveURL' && expected) routes.push(toPath(expected) ?? expected);
      return `Expect ${described} ${negated ? 'not ' : ''}${phrase}${expected !== undefined ? ` "${expected}"` : ''}`;
    }
  }
  return undefined;
}

function collectSteps(body: ts.Node, steps: string[], routes: string[]): void {
  const visit = (node: ts.Node) => {
    if (steps.length >= MAX_STEPS) return;
    if (ts.isExpressionStatement(node)) {
      // Cypress chains read left to right: cy.get(x).type('a').should(...) -> multiple steps.
      const chain: ts.CallExpression[] = [];
      let current: ts.Expression = unwrapExpression(node.expression);
      while (ts.isCallExpression(current)) {
        chain.unshift(current);
        const next = receiver(current);
        if (!next) break;
        current = unwrapExpression(next);
      }
      const described = chain.map(call => describeStep(call, routes)).filter((step): step is string => Boolean(step));
      // Keep only the outermost description for Playwright-style single actions.
      const unique = described.filter((step, index) => described.indexOf(step) === index);
      steps.push(...(unique.length ? unique : []).slice(0, MAX_STEPS - steps.length));
      return;
    }
    if (ts.isFunctionDeclaration(node)) return;
    ts.forEachChild(node, visit);
  };
  visit(body);
}

export function extractE2EFlows(sourceFiles: ts.SourceFile[], toProjectPath: (fileName: string) => string): E2EFlow[] {
  const flows: E2EFlow[] = [];
  for (const sourceFile of sourceFiles) {
    const text = sourceFile.text;
    const framework: E2EFlow['framework'] = /@playwright\/test|\bpage\.goto\(/.test(text) ? 'playwright'
      : /\bcy\.(visit|get|contains)\(/.test(text) ? 'cypress' : 'generic';
    if (framework === 'generic' && !/\b(page|browser|driver)\.(goto|click|fill|url)\(/.test(text)) continue;
    const file = toProjectPath(sourceFile.fileName);
    const walk = (node: ts.Node, suites: string[]) => {
      if (ts.isCallExpression(node)) {
        const base = unwrapExpression(node.expression);
        const name = ts.isIdentifier(base) ? base.text
          : ts.isPropertyAccessExpression(base) && ts.isIdentifier(base.expression) ? base.expression.text : undefined;
        const title = stringValue(node.arguments[0]);
        const callback = node.arguments.find(argument => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument)) as
          ts.ArrowFunction | ts.FunctionExpression | undefined;
        if (name && title && callback) {
          if (SUITE_FUNCTIONS.has(name) || (name === 'test' && ts.isPropertyAccessExpression(base) && base.name.text === 'describe')) {
            ts.forEachChild(callback.body, child => walk(child, [...suites, title]));
            return;
          }
          if (TEST_FUNCTIONS.has(name)) {
            const steps: string[] = [];
            const routes: string[] = [];
            collectSteps(callback.body, steps, routes);
            const label = clean([...suites, title].join(' › '), 240);
            if (steps.length && label) {
              flows.push({ title: label, file, line: lineOf(node), framework, steps, visitedRoutes: [...new Set(routes)], surfaceIds: [] });
            }
            return;
          }
        }
      }
      ts.forEachChild(node, child => walk(child, suites));
    };
    walk(sourceFile, []);
  }
  return flows;
}
