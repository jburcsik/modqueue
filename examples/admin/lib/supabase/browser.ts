'use client'

import { createBrowserClient } from '@supabase/ssr'

// Static property reads so Next inlines the values into the client bundle.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

export function browserClient() {
  if (!url || !anonKey) throw new Error('NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set at build time')
  return createBrowserClient(url, anonKey)
}
