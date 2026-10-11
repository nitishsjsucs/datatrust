/**
 * Imported first by paths.ts: zod decides at schema construction whether to compile fast parsers with
 * `new Function`, which workerd forbids, so the jitless path must be set before any schema module loads.
 */
import { z } from 'zod';

z.config({ jitless: true });
