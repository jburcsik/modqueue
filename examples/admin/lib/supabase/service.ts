import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from '../env'

/** Service-role client. Never reaches the browser; every moderation write goes through it. */
export function serviceClient(): SupabaseClient {
  return createClient(env.supabaseUrl(), env.serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}
