import { z } from 'zod';
import type {
  ChangedEntity,
  ChangedFile,
  EntityImpact,
} from '@graphentra/analyzer';
import type { ImpactReport } from './llm-client';

export type Confidence = 'high' | 'medium' | 'low';

export interface ApplicationContext {
  schemaVersion: '1.0';
  application: {
    name: string;
    summary: string;
    purpose: string;
  };
  domains: Array<{
    id: string;
    name: string;
    description: string;
  }>;
  terminology: Array<{
    term: string;
    meaning: string;
  }>;
  entityAnnotations: Array<{
    entityId: string;
    businessMeaning: string;
    domainIds: string[];
    confidence: Confidence;
  }>;
  applicationFacts: string[];
  unknowns: string[];
}

export const applicationContextSchema = z
  .object({
    schemaVersion: z.literal('1.0'),
    application: z
      .object({
        name: z.string(),
        summary: z.string(),
        purpose: z.string(),
      })
      .strict(),
    domains: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          description: z.string(),
        })
        .strict(),
    ),
    terminology: z.array(
      z
        .object({
          term: z.string(),
          meaning: z.string(),
        })
        .strict(),
    ),
    entityAnnotations: z.array(
      z
        .object({
          entityId: z.string(),
          businessMeaning: z.string(),
          domainIds: z.array(z.string()),
          confidence: z.enum(['high', 'medium', 'low']),
        })
        .strict(),
    ),
    applicationFacts: z.array(z.string()),
    unknowns: z.array(z.string()),
  })
  .strict();

export interface LegacyAnalysisResult {
  schemaVersion: '1.1';
  repository: {
    headSha: string;
  };
  evidenceIdentity?: string;
  changedFiles: ChangedFile[];
  changedEntities: ChangedEntity[];
  impacts: EntityImpact[];
  qaReport: ImpactReport;
  limitations: string[];
}
