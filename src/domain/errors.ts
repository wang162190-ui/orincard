export const domainErrorCodes = [
  "DOCUMENT_INVALID",
  "DOCUMENT_VERSION_UNSUPPORTED",
  "DOCUMENT_PLATFORM_DIMENSIONS_INVALID",
  "DOCUMENT_SLIDE_COUNT_INVALID",
  "DOCUMENT_SLIDE_ORDER_INVALID",
  "DOCUMENT_DUPLICATE_SLIDE_ID",
  "DOCUMENT_ASSET_REFERENCE_MISSING",
] as const;

export type DomainErrorCode = (typeof domainErrorCodes)[number];

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: DomainErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.details = details;
  }
}
