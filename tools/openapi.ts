export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'Graphentra Reports API',
    version: '1.0.0',
    description: 'Create, list, and read Graphentra QA impact reports.',
  },
  servers: [{ url: '/' }],
  tags: [
    { name: 'Reports', description: 'QA report operations' },
    { name: 'Documentation', description: 'API documentation' },
  ],
  paths: {
    '/reports': {
      post: {
        tags: ['Reports'],
        summary: 'Generate and save a QA report',
        description: 'Generates a QA report from completed analysis evidence and stores the report and its source data.',
        operationId: 'createReport',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['evidence', 'applicationContext'],
                properties: {
                  evidence: { type: 'object', required: ['outcome'], properties: { outcome: { type: 'string', enum: ['completed', 'no_changes', 'no_supported_changes', 'no_source_files'] } }, additionalProperties: true, description: 'Graphentra analysis evidence. outcome must be completed to generate a report.' },
                  applicationContext: { type: 'object', additionalProperties: true, description: 'Business context used to describe the impact in QA language.' },
                  applicationMap: { type: 'object', nullable: true, additionalProperties: true, description: 'Optional application surface map.' },
                  change: { $ref: '#/components/schemas/ChangeInfo' },
                },
              },
            },
          },
        },
        responses: {
          '201': {
            description: 'Report generated and stored.',
            content: { 'application/json': { schema: { type: 'object', required: ['id', 'change', 'qaReport'], properties: { id: { type: 'integer' }, change: { $ref: '#/components/schemas/ChangeInfo' }, qaReport: { $ref: '#/components/schemas/QAReport' } } } } },
          },
          '400': { description: 'Malformed JSON or invalid request.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '413': { description: 'Request body exceeds 20 MiB.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '422': { description: 'Analysis outcome does not require a QA report.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'Report generation or storage failed.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
      get: {
        tags: ['Reports'],
        summary: 'List QA reports',
        operationId: 'listReports',
        parameters: [
          { name: 'repository', in: 'query', description: 'Filter by repository name.', schema: { type: 'string' } },
          { name: 'pr', in: 'query', description: 'Filter by pull request number.', schema: { type: 'integer', minimum: 1 } },
          { name: 'branch', in: 'query', description: 'Filter by branch name.', schema: { type: 'string' } },
        ],
        responses: {
          '200': { description: 'Reports, newest first.', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/ReportListItem' } } } } },
          '500': { description: 'The report list could not be loaded.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/reports/{id}': {
      get: {
        tags: ['Reports'],
        summary: 'Get a QA report',
        operationId: 'getReport',
        parameters: [{ $ref: '#/components/parameters/ReportId' }],
        responses: {
          '200': { description: 'QA-facing report details.', content: { 'application/json': { schema: { type: 'object', required: ['id', 'createdAt', 'change', 'qaReport', 'markdown'], properties: { id: { type: 'integer' }, createdAt: { type: 'string', nullable: true, format: 'date-time' }, change: { $ref: '#/components/schemas/ChangeInfo' }, qaReport: { $ref: '#/components/schemas/QAReport' }, markdown: { type: 'string' } } } } } },
          '404': { description: 'Report not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          '500': { description: 'The report could not be loaded.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/reports/{id}/md': {
      get: {
        tags: ['Reports'],
        summary: 'Download a report as Markdown',
        operationId: 'getReportMarkdown',
        parameters: [{ $ref: '#/components/parameters/ReportId' }],
        responses: {
          '200': { description: 'Readable Markdown report.', content: { 'text/markdown': { schema: { type: 'string' } } } },
          '404': { description: 'Report not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/reports/{id}/technical': {
      get: {
        tags: ['Reports'],
        summary: 'Get technical report data',
        description: 'Returns the report evidence and analyzer data intended for engineering tools.',
        operationId: 'getTechnicalReport',
        parameters: [{ $ref: '#/components/parameters/ReportId' }],
        responses: {
          '200': { description: 'Stored evidence, graph, context, and QA report.', content: { 'application/json': { schema: { type: 'object', required: ['id', 'evidence', 'technicalGraph', 'applicationContext', 'applicationMap', 'qaReport'], properties: { id: { type: 'integer' }, evidenceIdentity: { type: 'string', nullable: true }, model: { type: 'string', nullable: true }, evidence: { type: 'object', additionalProperties: true }, technicalGraph: { type: 'object', additionalProperties: true }, applicationContext: { type: 'object', additionalProperties: true }, applicationMap: { type: 'object', nullable: true, additionalProperties: true }, qaReport: { type: 'object', additionalProperties: true } } } } } },
          '404': { description: 'Report not found.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/openapi.json': {
      get: {
        tags: ['Documentation'],
        summary: 'Get the OpenAPI specification',
        operationId: 'getOpenApiSpec',
        responses: { '200': { description: 'OpenAPI 3.0 document.', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/docs': {
      get: {
        tags: ['Documentation'],
        summary: 'Open interactive Swagger UI',
        operationId: 'getSwaggerUi',
        responses: { '200': { description: 'Swagger UI HTML page.', content: { 'text/html': { schema: { type: 'string' } } } } },
      },
    },
  },
  components: {
    parameters: {
      ReportId: { name: 'id', in: 'path', required: true, description: 'Numeric report ID.', schema: { type: 'integer', minimum: 1 } },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: { error: { type: 'string' }, issues: { type: 'array', items: { type: 'string' } } },
      },
      Person: {
        type: 'object',
        additionalProperties: false,
        properties: { name: { type: 'string', maxLength: 200 }, email: { type: 'string', maxLength: 320 }, login: { type: 'string', maxLength: 200 } },
      },
      ChangeInfo: {
        type: 'object',
        additionalProperties: false,
        properties: {
          repository: { type: 'string', maxLength: 300 },
          branch: { type: 'string', maxLength: 300 },
          baseBranch: { type: 'string', maxLength: 300 },
          commit: { type: 'object', additionalProperties: false, properties: { sha: { type: 'string', maxLength: 64 }, message: { type: 'string', maxLength: 2000 }, committedAt: { type: 'string', maxLength: 64 }, url: { type: 'string', format: 'uri', maxLength: 2000 } } },
          author: { $ref: '#/components/schemas/Person' },
          pullRequest: { type: 'object', additionalProperties: false, properties: { number: { type: 'integer', minimum: 1 }, title: { type: 'string', maxLength: 500 }, url: { type: 'string', format: 'uri', maxLength: 2000 }, author: { $ref: '#/components/schemas/Person' }, description: { type: 'string', maxLength: 10000 }, labels: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 100 } } } },
        },
      },
      QAReport: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          keyChanges: { type: 'array', items: { type: 'string' } },
          testAreas: { type: 'array', items: { type: 'object', additionalProperties: true } },
          qaChecks: { type: 'array', items: { type: 'string' } },
          openQuestions: { type: 'array', items: { type: 'string' } },
        },
      },
      ReportListItem: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          createdAt: { type: 'string', nullable: true, format: 'date-time' },
          repository: { type: 'string', nullable: true },
          branch: { type: 'string', nullable: true },
          pullRequest: { type: 'object', nullable: true, properties: { number: { type: 'integer', nullable: true }, title: { type: 'string', nullable: true }, url: { type: 'string', nullable: true } } },
          changedBy: { type: 'string', nullable: true },
          commitMessage: { type: 'string', nullable: true },
          summary: { type: 'string', nullable: true },
        },
      },
    },
  },
} as const;
