function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set; copy .env.example to .env.local and fill it in`)
  return value
}

export const env = {
  supabaseUrl: () => required('NEXT_PUBLIC_SUPABASE_URL'),
  anonKey: () => required('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  serviceRoleKey: () => required('SUPABASE_SERVICE_ROLE_KEY'),
}
