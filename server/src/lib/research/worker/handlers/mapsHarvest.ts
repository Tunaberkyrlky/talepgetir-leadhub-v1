/**
 * maps:harvest — async maps-scrape discovery routed by geography (Gosom/Google Maps for the West;
 * 2GIS for the CIS in M2), feeding the SAME capped, hold-fenced, once-ever-billed harvest pipeline
 * as harvest:run. The ONLY difference from harvest:run is the discovery source (engine/sources.ts);
 * canonicalize → dedup → fetch → validate → persist → bill → reconcile → settle are shared via
 * runHarvest, so all money invariants (reservation cap, lease fencing, KVKK suppression > dedup,
 * once-ever billing) hold identically. Like harvest:run this spends real money downstream and is
 * not cost-idempotent, so it is enqueued maxAttempts:1 (an operator re-runs on failure; the
 * idempotent bill RPC + reconciliation pass make a re-run safe).
 */
import type { JobHandler } from '../types.js';
import { runHarvest } from './harvestRun.js';
import { mapsSource } from '../../engine/sources.js';

export const mapsHarvestHandler: JobHandler = (ctx) => runHarvest(ctx, mapsSource);
