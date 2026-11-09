import { NextResponse } from 'next/server'
import { ZodError } from 'zod'
import { ERROR_HTTP_STATUS, ModerationError, type ModerationErrorCode } from 'modqueue'

export type ApiErrorBody = { error: { code: string; message: string } }

// The browser gets a fixed message per code; the thrown message stays in the server log.
const MESSAGES: Record<ModerationErrorCode, string> = {
  unauthenticated: 'Sign in to continue.',
  forbidden: 'Your role cannot do this.',
  not_found: 'Not found.',
  invalid_input: 'The request was not valid.',
  rate_limited: 'Too many requests. Try again later.',
  account_too_new: 'This account is too new for that.',
  self_report: 'You cannot report your own content.',
  duplicate_report: 'You already have an open report on this content.',
  duplicate_appeal: 'This strike already has a pending appeal.',
  not_strike_owner: 'This strike belongs to another member.',
  strike_inactive: 'This strike is no longer active.',
  appeal_not_pending: 'This appeal has already been resolved.',
  case_not_open: 'This case is no longer open.',
  case_claimed_by_other: 'Another moderator holds this case.',
  posting_paused: 'Posting is paused for this account.',
  content_blocked: 'This content cannot be posted.',
  store_error: 'Something went wrong. Try again.',
}

function errorResponse(err: unknown): NextResponse<ApiErrorBody> {
  const code: ModerationErrorCode = ModerationError.is(err) ? err.code : err instanceof ZodError ? 'invalid_input' : 'store_error'
  if (code === 'store_error') console.error(err)
  return NextResponse.json({ error: { code, message: MESSAGES[code] } }, { status: ERROR_HTTP_STATUS[code] })
}

/** Wraps a handler so every thrown error becomes `{ error: { code, message } }` with the mapped status. */
export function handle<T>(fn: () => Promise<T>): Promise<NextResponse<T | ApiErrorBody>> {
  return fn().then((data) => NextResponse.json(data)).catch(errorResponse)
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new ModerationError('invalid_input', 'body is not JSON')
  }
}
