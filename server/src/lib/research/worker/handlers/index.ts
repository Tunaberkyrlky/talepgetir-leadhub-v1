/**
 * Handler registry — maps research_jobs.type → handler.
 * Register new job handlers here (and add the type to lib/research/jobTypes.ts).
 */
import type { JobHandler } from '../types.js';
import { RESEARCH_JOB_TYPES } from '../../jobTypes.js';
import { pingHandler } from './ping.js';
import { icpGenerateHandler } from './icpGenerate.js';
import { icpReviseHandler } from './icpRevise.js';
import { geoAnalyzeHandler } from './geoAnalyze.js';
import { harvestRunHandler } from './harvestRun.js';
import { mapsHarvestHandler } from './mapsHarvest.js';
import { tradeIngestHandler } from './tradeIngest.js';
import { tradeHarvestHandler } from './tradeHarvest.js';
import { channelsDiscoverHandler } from './channelsDiscover.js';
import { channelsHarvestHandler } from './channelsHarvest.js';
import { offerGenerateHandler } from './offerGenerate.js';
import { linkedinValidateHandler } from './linkedinValidate.js';
import { linkedinInviteHandler } from './linkedinInvite.js';
import { linkedinMessageHandler } from './linkedinMessage.js';
import { linkedinWithdrawHandler } from './linkedinWithdraw.js';

const handlers: Record<string, JobHandler> = {
    [RESEARCH_JOB_TYPES.PING]: pingHandler,
    [RESEARCH_JOB_TYPES.ICP_GENERATE]: icpGenerateHandler,
    [RESEARCH_JOB_TYPES.ICP_REVISE]: icpReviseHandler,
    [RESEARCH_JOB_TYPES.GEO_ANALYZE]: geoAnalyzeHandler,
    [RESEARCH_JOB_TYPES.HARVEST_RUN]: harvestRunHandler,
    [RESEARCH_JOB_TYPES.MAPS_HARVEST]: mapsHarvestHandler,
    [RESEARCH_JOB_TYPES.TRADE_INGEST]: tradeIngestHandler,
    [RESEARCH_JOB_TYPES.TRADE_HARVEST]: tradeHarvestHandler,
    [RESEARCH_JOB_TYPES.CHANNELS_DISCOVER]: channelsDiscoverHandler,
    [RESEARCH_JOB_TYPES.CHANNELS_HARVEST]: channelsHarvestHandler,
    [RESEARCH_JOB_TYPES.OFFER_GENERATE]: offerGenerateHandler,
    [RESEARCH_JOB_TYPES.LINKEDIN_VALIDATE]: linkedinValidateHandler,
    [RESEARCH_JOB_TYPES.LINKEDIN_INVITE]: linkedinInviteHandler,
    [RESEARCH_JOB_TYPES.LINKEDIN_MESSAGE]: linkedinMessageHandler,
    [RESEARCH_JOB_TYPES.LINKEDIN_WITHDRAW]: linkedinWithdrawHandler,
};

export function getHandler(type: string): JobHandler | undefined {
    return handlers[type];
}

/** Job types the worker can currently run. */
export function registeredJobTypes(): string[] {
    return Object.keys(handlers);
}
