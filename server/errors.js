export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (message) => new AppError(400, 'bad_request', message);
export const notFound = (what) => new AppError(404, 'not_found', `${what} not found`);
export const forbidden = (message) => new AppError(403, 'forbidden', message);
export const conflict = (code, message) => new AppError(409, code, message);

export function requireInt(value, name, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  if (!Number.isInteger(n) || n < min || n > max) throw badRequest(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}
