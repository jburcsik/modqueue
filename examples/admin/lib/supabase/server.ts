import { createServerClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { env } from '@/lib/env'

export { serviceClient } from './service'

/** Anon client bound to the caller's session cookies. Used only to identify the caller. */
export async function sessionClient(): Promise<SupabaseClient> {
  const cookieStore = await cookies()
  return createServerClient(env.supabaseUrl(), env.anonKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) cookieStore.set(name, value, options)
        } catch {
          // A server component cannot write cookies; proxy.ts refreshes the session instead.
        }
      },
    },
  })
}
