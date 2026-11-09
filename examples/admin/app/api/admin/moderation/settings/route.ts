import { ModerationError, settingsSchema } from 'modqueue'
import { handle, readJson } from '@/lib/api'
import { requireRole } from '@/lib/kit'

export async function GET() {
  return handle(async () => {
    const { store } = await requireRole('moderator')
    return { settings: await store.loadSettings() }
  })
}

export async function PUT(request: Request) {
  return handle(async () => {
    const { principal, store } = await requireRole('admin')
    const patch = settingsSchema.parse(await readJson(request))
    if (patch.automationLevel === 'full_auto' && !patch.fullAutoAcknowledgedAt) {
      throw new ModerationError('invalid_input', 'full_auto requires the acknowledgement')
    }
    return { settings: await store.saveSettings(patch, principal.userId) }
  })
}
