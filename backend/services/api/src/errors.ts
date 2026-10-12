import { decodeErrorResult, type Abi, type Hex } from 'viem';
import { API_ERROR, CONTRACT_ERROR_TO_CODE, EXTRA_ERRORS_ABI, type ApiErrorCode } from '@scanpay/shared';

let DECODE_ABI: Abi = EXTRA_ERRORS_ABI as Abi;

export function setDecodeAbi(abi: Abi) {
  DECODE_ABI = [...(EXTRA_ERRORS_ABI as Abi), ...abi];
}

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly httpStatus: number;
  readonly details?: unknown;
  readonly errorName?: string;

  constructor(code: ApiErrorCode, message?: string, details?: unknown, errorName?: string) {
    const info = API_ERROR[code];
    super(message ?? info?.message ?? code);
    this.code = code;
    this.httpStatus = info?.http ?? 422;
    this.details = details;
    this.errorName = errorName;
    this.name = 'ApiError';
  }
}

export function decodeChainError(data: Hex | undefined): ApiError | null {
  if (!data || data === '0x') return null;
  try {
    const decoded = decodeErrorResult({ abi: DECODE_ABI, data });
    const code = CONTRACT_ERROR_TO_CODE[decoded.errorName as string] ?? 'CHAIN_REVERT';
    const msg = decoded.args?.length ? String(decoded.args[0]) : decoded.errorName;
    return new ApiError(code, msg, undefined, decoded.errorName);
  } catch {
    return null;
  }
}

export function notFound(entity = 'Resource'): ApiError {
  return new ApiError('NOT_FOUND', `${entity} not found`);
}
