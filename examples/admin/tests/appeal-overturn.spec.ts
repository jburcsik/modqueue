import { expect, test } from '@playwright/test'
import { ephemeralMember, heldContentFor, login, logout, memberClient, serviceClient } from './helpers.ts'

test('an overturned appeal revokes the strike and restores the content', async ({ page }) => {
  const appellant = await ephemeralMember('appellant')
  try {
    const { contentId, caseId, ownerId } = await heldContentFor(appellant.id, 'appeal')

    // The moderator removes with a strike through the admin.
    await login(page, 'moderator@example.com')
    await page.goto(`/admin/moderation?case=${caseId}`)
    const card = page.locator(`[data-case-id="${caseId}"]`)
    await card.getByRole('button', { name: 'Claim' }).click()
    await expect(card.getByText('claimed by you')).toBeVisible()
    await card.getByLabel('Operation').selectOption('remove')
    await card.getByLabel('Strike').selectOption('warning')
    await card.getByLabel('Reason').fill('e2e: off topic, strike to appeal')
    await card.getByRole('button', { name: 'Apply' }).click()
    await expect(card.getByTestId('case-state')).toHaveText('decided')

    const admin = serviceClient()
    const { data: event } = await admin.from('moderation_events').select('id').eq('case_id', caseId).eq('event_type', 'content_remove').single()
    const { data: strike } = await admin.from('user_strikes').select('id, revoked_at').eq('moderation_event_id', event!.id).single()
    expect(strike?.revoked_at).toBeNull()

    // The member files the appeal through the client-callable function.
    const memberApi = await memberClient(appellant.email)
    const { data: appealId, error } = await memberApi.rpc('file_appeal', {
      p_strike_id: strike!.id,
      p_statement: 'e2e: the post was a question about the community garden, not off topic.',
    })
    expect(error, error?.message).toBeNull()
    await memberApi.auth.signOut()

    // The admin overturns it with a note.
    await logout(page)
    await login(page, 'admin@example.com')
    await page.goto('/admin/moderation/appeals')
    const appeal = page.locator(`[data-appeal-id="${appealId}"]`)
    await expect(appeal).toBeVisible()
    await appeal.getByLabel('Reviewer note').fill('e2e: agreed, restoring')
    await appeal.getByRole('button', { name: 'Overturn' }).click()
    await expect(page.locator(`[data-appeal-id="${appealId}"]`)).toHaveCount(0)

    const { data: content } = await admin.from('moderation_content').select('moderation_state').eq('id', contentId).single()
    expect(content?.moderation_state).toBe('visible')
    const { data: revoked } = await admin.from('user_strikes').select('revoked_at, user_id').eq('id', strike!.id).single()
    expect(revoked?.user_id).toBe(ownerId)
    expect(revoked?.revoked_at).not.toBeNull()
    const { data: row } = await admin.from('moderation_cases').select('state').eq('id', caseId).single()
    expect(row?.state).toBe('reversed')
  } finally {
    await appellant.remove()
  }
})
