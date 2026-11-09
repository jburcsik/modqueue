import { expect, test } from '@playwright/test'
import { heldContent, login, member, serviceClient } from './helpers.ts'

test('a moderator claims a case and removes the content with a strike', async ({ page }) => {
  const { contentId, caseId } = await heldContent(member(1), 'queue')

  await login(page, 'moderator@example.com')
  await page.goto(`/admin/moderation?case=${caseId}`)

  const card = page.locator(`[data-case-id="${caseId}"]`)
  await expect(card).toBeVisible()
  await expect(card.getByTestId('case-state')).toHaveText('open')

  await card.getByRole('button', { name: 'Claim' }).click()
  await expect(card.getByText('claimed by you')).toBeVisible()
  await expect(card.getByTestId('case-state')).toHaveText('claimed')

  // Remove without a reason is refused on the spot, and says so.
  await card.getByLabel('Operation').selectOption('remove')
  await card.getByRole('button', { name: 'Apply' }).click()
  await expect(card.getByTestId('action-error')).toContainText(/reason/i)
  await expect(card.getByLabel('Reason')).toBeFocused()

  await card.getByLabel('Strike').selectOption('violation')
  await card.getByLabel('Reason').fill('e2e: targets a named person')
  await card.getByRole('button', { name: 'Apply' }).click()

  // The deep link follows the case into the decided view: settled, removed, with the events.
  await expect(card.getByTestId('case-state')).toHaveText('decided')
  await expect(card.getByTestId('content-state')).toHaveText('removed')
  await expect(card.locator('[data-event-type="content_remove"]')).toHaveCount(1)
  // The strike lands on the owner, so the card's owner strike points move off zero.
  await expect(card.getByText(/[1-9]\d* strike points/)).toBeVisible()

  // The row has left the open view.
  await page.goto('/admin/moderation?filter=open')
  await expect(page.locator(`[data-case-id="${caseId}"]`)).toHaveCount(0)

  const admin = serviceClient()
  const { data: content } = await admin.from('moderation_content').select('moderation_state').eq('id', contentId).single()
  expect(content?.moderation_state).toBe('removed')
  const { data: event } = await admin.from('moderation_events').select('id').eq('case_id', caseId).eq('event_type', 'content_remove').single()
  const { data: strikes } = await admin.from('user_strikes').select('severity, points').eq('moderation_event_id', event!.id)
  expect(strikes?.[0]?.severity).toBe('violation')
})

test('a failed action shows the error code inline', async ({ page }) => {
  const { caseId } = await heldContent(member(2), 'conflict')

  await login(page, 'moderator@example.com')
  await page.goto(`/admin/moderation?case=${caseId}`)
  const card = page.locator(`[data-case-id="${caseId}"]`)
  await card.getByRole('button', { name: 'Claim' }).click()
  await expect(card.getByText('claimed by you')).toBeVisible()

  // A second tab still shows the case open while the first settles it.
  const stale = await page.context().newPage()
  await stale.goto(`/admin/moderation?case=${caseId}`)
  const staleCard = stale.locator(`[data-case-id="${caseId}"]`)
  await expect(staleCard.getByTestId('case-state')).toHaveText('claimed')

  await card.getByLabel('Operation').selectOption('dismiss')
  await card.getByRole('button', { name: 'Apply' }).click()
  await expect(card.getByTestId('case-state')).toHaveText('decided')

  // The stale tab's action is refused by the kit, and the page says which code.
  await staleCard.getByLabel('Operation').selectOption('approve')
  await staleCard.getByRole('button', { name: 'Apply' }).click()
  await expect(staleCard.getByTestId('action-error')).toContainText('case_not_open')
  await stale.close()
})
