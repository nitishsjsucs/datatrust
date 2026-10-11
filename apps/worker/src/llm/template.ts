import { type ChatMessage, type SanitizedEvidence, templateDraft } from '@datatrust/rca';
import type { Summarizer } from './summarizer';

/** Deterministic template (CI, and the fallback for LLM drafts that fail grounding). */
export class TemplateSummarizer implements Summarizer {
  readonly provider = 'template' as const;
  readonly model = 'template-v1';

  async draft(_messages: ChatMessage[], evidence: SanitizedEvidence): Promise<unknown> {
    return templateDraft(evidence);
  }
}
