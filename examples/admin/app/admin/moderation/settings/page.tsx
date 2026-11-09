import { requireRole } from '@/lib/kit'
import { SettingsForm } from '@/components/settings-form'

export default async function SettingsPage() {
  const { principal, store } = await requireRole('moderator')
  const settings = await store.loadSettings()
  return (
    <>
      <h1>Moderation settings</h1>
      <p className="muted small">Admins save; moderators read. Values apply to new submissions at once.</p>
      <SettingsForm initial={settings} canSave={principal.role === 'admin'} />
    </>
  )
}
