import { RestStagingDO } from "@bio-mcp/shared/staging/rest-staging-do";

/**
 * Minimal staging DO for DoltHub.
 * Only used when agents explicitly stage results via db.stage().
 * No schema hints needed — DoltHub provides authoritative schema in query responses.
 */
export class DoltHubDataDO extends RestStagingDO {}
