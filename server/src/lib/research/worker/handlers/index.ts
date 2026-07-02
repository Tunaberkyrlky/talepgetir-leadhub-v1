/**
 * Handler registry — maps research_jobs.type → handler.
 * Register new job handlers here (and add the type to lib/research/jobTypes.ts).
 */
import type { JobHandler } from '../types.js';
import { RESEARCH_JOB_TYPES } from '../../jobTypes.js';
import { pingHandler } from './ping.js';
import { icpGenerateHandler } from './icpGenerate.js';
import { harvestRunHandler } from './harvestRun.js';

const handlers: Record<string, JobHandler> = {
    [RESEARCH_JOB_TYPES.PING]: pingHandler,
    [RESEARCH_JOB_TYPES.ICP_GENERATE]: icpGenerateHandler,
    [RESEARCH_JOB_TYPES.HARVEST_RUN]: harvestRunHandler,
};

export function getHandler(type: string): JobHandler | undefined {
    return handlers[type];
}

/** Job types the worker can currently run. */
export function registeredJobTypes(): string[] {
    return Object.keys(handlers);
}
