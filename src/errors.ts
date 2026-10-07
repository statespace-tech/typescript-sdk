export type JsonValue =
  null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** A request to Statespace failed or the client is misconfigured. */
export class StatespaceError extends Error {}

/** A request that retrying cannot fix. */
export class PermanentError extends StatespaceError {}

/** A component trapped or returned an invalid value. */
export class FunctionError extends StatespaceError {}

/** A component exceeded its timeout. */
export class FunctionTimeout extends FunctionError {}
