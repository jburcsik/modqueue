import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/**', 'examples/**', 'supabase/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
)
