/**
 * Handler registry — maps research_jobs.type → handler.
 * Register new job handlers here (and add the type to lib/research/jobTypes.ts).
 */
import type { JobHandler } from '../types.js';
import { RESEARCH_JOB_TYPES } from '../../jobTypes.js';
import { pingHandler } from './ping.js';
import { icpGenerateHandler } from './icpGenerate.js';
import { harvestRunHandler } from './harvestRun.js';
import { mapsHarvestHandler } from './mapsHarvest.js';
import { tradeIngestHandler } from './tradeIngest.js';
import { tradeHarvestHandler } from './tradeHarvest.js';

const handlers: Record<string, JobHandler> = {
    [RESEARCH_JOB_TYPES.PING]: pingHandler,
    [RESEARCH_JOB_TYPES.ICP_GENERATE]: icpGenerateHandler,
    [RESEARCH_JOB_TYPES.HARVEST_RUN]: harvestRunHandler,
    [RESEARCH_JOB_TYPES.MAPS_HARVEST]: mapsHarvestHandler,
    [RESEARCH_JOB_TYPES.TRADE_INGEST]: tradeIngestHandler,
    [RESEARCH_JOB_TYPES.TRADE_HARVEST]: tradeHarvestHandler,
};

export function getHandler(type: string): JobHandler | undefined {
    return handlers[type];
}

/** Job types the worker can currently run. */
export function registeredJobTypes(): string[] {
    return Object.keys(handlers);
}
