"""Open a tool through the collapsed sidebar, as a user would."""
def click_sidebar_tool(page, title):
    card=page.locator('.tool-card').filter(has=page.locator('strong',has_text=title)).first
    group=card.locator('xpath=ancestor::details[1]')
    if group.get_attribute('open') is None:
        group.locator('summary').click()
    card.click()
