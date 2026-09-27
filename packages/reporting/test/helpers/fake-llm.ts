/**
 * Offline fake OpenAI-compatible client. It answers each Graphentra structured request by schema
 * name so the full context + report pipeline can be exercised without network access.
 */
export interface FakeCall { schema: string; body: any; user: any }

export interface FakeLlmOptions {
  /** Omit this many annotations on the first module attempt (tests the coverage correction). */
  dropFirstModuleAnnotations?: number;
  /** First QA answer cites an unknown surface ID (tests the referential correction). */
  inventSurfaceOnce?: boolean;
  qaReport?: (payload: any) => unknown;
}

function lastUserJson(body: any): any {
  const user = body.messages.find((message: any) => message.role === 'user')?.content ?? '';
  const start = user.indexOf('{');
  try { return JSON.parse(start >= 0 ? user.slice(start) : user); } catch { return {}; }
}

export function createFakeLlm(options: FakeLlmOptions = {}) {
  const calls: FakeCall[] = [];
  let moduleAttempts = 0;
  let inventedSurface = false;
  const respond = (body: any) => {
    const schema = body.response_format?.json_schema?.name;
    const user = lastUserJson(body);
    calls.push({ schema, body, user });
    const isCorrection = body.messages.length > 2;
    switch (schema) {
      case 'graphentra_context_module': {
        moduleAttempts += 1;
        let entities = user.entitiesToDescribe as Array<{ id: string; name: string; file: string }>;
        if (!isCorrection && options.dropFirstModuleAnnotations) entities = entities.slice(options.dropFirstModuleAnnotations);
        return {
          moduleSummaries: [...new Set(entities.map(entity => entity.file))].map(file => ({ file, summary: `Business role of ${file}.` })),
          entityAnnotations: entities.map(entity => ({
            entityId: entity.id,
            businessMeaning: entity.name === 'chargeCard' ? 'Approves a card payment only when a card is present and the amount meets the minimum order amount.'
              : `Handles ${entity.name.replace(/([A-Z])/g, ' $1').toLowerCase()}.`,
            userVisibleEffect: entity.name === 'chargeCard' ? 'Customers see "Payment was declined" when the charge is refused.' : '',
            basis: 'code', confidence: 'high',
          })),
          rules: entities.some(entity => entity.name === 'chargeCard')
            ? [{ statement: 'Payments below the minimum order amount of 1.00 are declined; exactly 1.00 is accepted.', entityIds: entities.filter(entity => entity.name === 'chargeCard').map(entity => entity.id), kind: 'observed', basis: 'code' }]
            : [],
          glossary: [{ term: 'saved card', identifiers: ['cardToken'], meaning: 'The customer card used to pay.' }],
          questions: [],
        };
      }
      case 'graphentra_context_synthesis':
        return {
          application: { name: 'Shopfront', summary: 'Customer storefront with cart and card checkout.', purpose: 'Sell products online.', platform: 'fullstack' },
          userRoles: [{ id: 'customer', name: 'Customer', description: 'A signed-in shopper.' }],
          features: [{
            id: 'checkout', name: 'Checkout and payment', description: 'Cart review, card payment, and order placement.',
            criticality: 'critical', criticalityReason: 'Takes customer money.', modules: user.modules,
            surfaceIds: (user.applicationMap?.surfaces ?? []).map((surface: any) => surface.id), basis: 'code',
          }],
          glossary: [{ term: 'minimum order amount', identifiers: ['MIN_ORDER_AMOUNT'], meaning: 'Smallest payable order total.', basis: 'code' }],
          openQuestions: [{ question: 'Should an order of exactly the minimum amount be accepted?', entityIds: [], featureIds: ['checkout'] }],
          unknowns: [],
        };
      case 'graphentra_context_surfaces':
        return {
          surfaces: user.surfaces.map((surface: any) => ({
            surfaceId: surface.id,
            businessName: surface.kind === 'ui_route' ? `${surface.route} page` : `${surface.method} ${surface.route} API`,
            purpose: 'Part of checkout.', featureIds: ['checkout'],
            howToReach: surface.navigationSteps.length ? surface.navigationSteps : [`Open ${surface.route} directly (no in-app link was found in code)`],
            access: surface.accessHints.length ? 'Signed-in customers only' : 'No access restriction found in code',
            setup: ['A signed-in customer with a cart'], basis: 'code',
          })),
        };
      case 'qa_change_impact_report': {
        const pack = user.applicationContext;
        if (options.qaReport) return options.qaReport(user);
        const invent = options.inventSurfaceOnce && !inventedSurface;
        if (invent) inventedSurface = true;
        const area = pack.changes[0]?.affectedAreas[0];
        return {
          summary: 'Card payments at exactly the minimum order amount are now declined.',
          keyChanges: ['Orders totalling exactly 1.00 are now declined at payment instead of being accepted.'],
          testAreas: [{
            area: area?.businessName ?? 'Checkout',
            surfaceIds: invent ? ['ui:/invented'] : area ? [area.surfaceId, ...area.usedByPages.map((page: any) => page.surfaceId)] : [],
            howToReach: area?.usedByPages[0]?.howToReach.join(', then ') ?? 'Navigation was not found in code.',
            access: area?.access ?? 'Unknown',
            setup: 'A signed-in customer with a cart totalling exactly 1.00.',
            checks: ['Verify an order of exactly 1.00 shows "Payment was declined" and one of 1.01 is placed.'],
          }],
          uncertainty: ['It is unclear whether declining exactly 1.00 is intended.'],
        };
      }
      default:
        throw new Error(`Unexpected schema ${schema}`);
    }
  };
  const client: any = {
    chat: {
      completions: {
        create: (body: any) => {
          const completion = {
            id: `fake-${calls.length + 1}`, model: body.model,
            choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(respond(body)) } }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
          const promise: any = Promise.resolve(completion);
          promise.withResponse = async () => ({ data: completion, request_id: 'fake-request' });
          return promise;
        },
      },
    },
  };
  return { client, calls, get moduleAttempts() { return moduleAttempts; } };
}
