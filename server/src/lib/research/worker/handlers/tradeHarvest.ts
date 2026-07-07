/** Y2 explicit Research: imported batch -> shared validation/verdict/MATCH billing pipeline. */
import type { JobHandler } from '../types.js';
import { tradeBatchSource } from '../../engine/sources.js';
import { runHarvest } from './harvestRun.js';

export const tradeHarvestHandler: JobHandler = async (ctx) => {
    const batchId = typeof ctx.job.payload?.batch_id === 'string' ? ctx.job.payload.batch_id : null;
    if (!batchId) throw new Error('trade:harvest requires payload.batch_id');
    return runHarvest(ctx, tradeBatchSource(batchId));
};
