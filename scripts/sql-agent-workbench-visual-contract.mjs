export const requiredAgentAriaLabels = [
	'Agent prompt',
	'Agent task',
	'Agent access mode',
	'Start Agent run',
	'Cancel Agent run',
	'Agent evidence',
	'Agent activity',
	'Agent warnings'
];

export const expectedAgentTabOrder = ['Agent prompt', 'Agent task', 'Agent access mode', 'Start Agent run'];

export function createAgentWorkbenchSnapshotExpression() {
	return `(() => {
  const rect = element => {
    const value = element?.getBoundingClientRect();
    return value ? { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height } : undefined;
  };
  const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
  const root = document.querySelector('.sql-agent-view');
  const statusElement = document.querySelector('.sql-agent-status');
  const controls = [...document.querySelectorAll('.sql-agent-view textarea, .sql-agent-view select, .sql-agent-view button')].map(element => ({
    tag: element.tagName,
    ariaLabel: element.getAttribute('aria-label') || '',
    disabled: Boolean(element.disabled),
    visible: visible(element),
    rect: rect(element)
  }));
  const notificationSeverity = element => {
    if (element.querySelector('.notification-list-item-icon.codicon-error')) return 'error';
    if (element.querySelector('.notification-list-item-icon.codicon-warning')) return 'warning';
    if (element.querySelector('.notification-list-item-icon.codicon-info')) return 'info';
    return 'unknown';
  };
  const notificationOverlays = [
    ...document.querySelectorAll('.monaco-workbench > .notifications-toasts.visible > .notification-toast-container > .notification-toast'),
    ...document.querySelectorAll('.monaco-workbench > .notifications-center.visible')
  ].map(element => ({
    kind: element.classList.contains('notifications-center') ? 'center' : 'toast',
    severity: notificationSeverity(element),
    visible: visible(element),
    rect: rect(element)
  })).filter(overlay => overlay.visible);
  return {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    userAgent: navigator.userAgent,
    workbenchReady: visible(document.querySelector('.monaco-workbench')),
    primarySidebarVisible: visible(document.querySelector('.part.sidebar')),
    statusBar: (() => {
      const element = document.querySelector('.monaco-workbench .part.statusbar');
      return { visible: visible(element), rect: rect(element) };
    })(),
    agentRoot: { visible: visible(root), rect: rect(root) },
    statusElement: { visible: visible(statusElement), rect: rect(statusElement) },
    notificationOverlays,
    ariaLabels: [...document.querySelectorAll('.sql-agent-view [aria-label]')].map(element => element.getAttribute('aria-label')),
    controls,
    status: document.querySelector('.sql-agent-status')?.textContent?.trim() || '',
    fatalScreen: document.body.innerText.includes('Nyala failed to start')
  };
})()`;
}

export function validateAgentWorkbenchSnapshot(snapshot, viewport, tabOrder) {
	const checks = [];
	const statusBarRect = snapshot.statusBar?.rect;
	const statusElementRect = snapshot.statusElement?.rect;
	const statusBarWithinViewport =
		snapshot.statusBar?.visible && isPositiveRect(statusBarRect) && rectWithinViewport(statusBarRect, viewport);
	const notificationOverlays = Array.isArray(snapshot.notificationOverlays) ? snapshot.notificationOverlays : undefined;
	const notificationOverlayBoundsValid =
		notificationOverlays !== undefined &&
		notificationOverlays.every(
			overlay =>
				overlay?.visible === true &&
				['toast', 'center'].includes(overlay.kind) &&
				['error', 'warning', 'info', 'unknown'].includes(overlay.severity) &&
				rectWithinViewport(overlay.rect, viewport)
		);
	checks.push(check('workbench-ready', snapshot.workbenchReady, 'Workbench root is visible'));
	checks.push(
		check(
			'statusbar-bounds',
			statusBarWithinViewport,
			`${formatRect(statusBarRect)} in ${viewport.width}x${viewport.height}`
		)
	);
	checks.push(
		check(
			'notification-overlay-bounds',
			notificationOverlayBoundsValid,
			notificationOverlays === undefined
				? 'notification overlay snapshot is missing'
				: `${notificationOverlays.length} visible notification overlay(s) are bounded in ${viewport.width}x${viewport.height}`
		)
	);
	checks.push(
		check(
			'no-visible-error-notifications',
			notificationOverlays !== undefined && !notificationOverlays.some(overlay => overlay?.severity === 'error'),
			`${notificationOverlays?.filter(overlay => overlay?.severity === 'error').length ?? 'unknown'} visible error notification(s)`
		)
	);
	if (viewport.width <= 420) {
		checks.push(
			check(
				'narrow-focused-layout',
				snapshot.primarySidebarVisible === false,
				'Primary side bar is hidden for the narrow focused layout'
			)
		);
	}
	checks.push(check('agent-root-visible', snapshot.agentRoot?.visible, 'SQL Agent root is visible'));
	checks.push(check('status-element-visible', snapshot.statusElement?.visible, 'Agent status is visible'));
	checks.push(
		check(
			'status-element-bounds',
			snapshot.statusElement?.visible === true &&
				rectWithinViewport(statusElementRect, viewport) &&
				clearsStatusBarRectWithTolerance(statusElementRect, statusBarRect) &&
				clearsNotificationOverlays(statusElementRect, notificationOverlays),
			`${formatRect(statusElementRect)} in ${viewport.width}x${viewport.height}; clear of statusbar and notification overlays`
		)
	);
	const agentRootRect = snapshot.agentRoot?.rect;
	const agentRootWithinSurface =
		notificationOverlayBoundsValid &&
		isPositiveRect(agentRootRect) &&
		rectWithinViewport(agentRootRect, viewport) &&
		clearsStatusBarRectWithTolerance(agentRootRect, statusBarWithinViewport ? statusBarRect : undefined) &&
		clearsNotificationOverlays(agentRootRect, notificationOverlays);
	checks.push(
		check(
			'agent-root-bounds',
			agentRootWithinSurface,
			`${formatRect(agentRootRect)} in ${viewport.width}x${viewport.height}; ${
				clearsStatusBarRectWithTolerance(agentRootRect, statusBarWithinViewport ? statusBarRect : undefined)
					? 'clear of statusbar'
					: 'overlaps statusbar'
			}; ${
				clearsNotificationOverlays(agentRootRect, notificationOverlays)
					? 'clear of notification overlays'
					: 'overlaps a notification overlay'
			}`
		)
	);
	for (const label of requiredAgentAriaLabels) {
		checks.push(
			check(`aria-${slug(label)}`, snapshot.ariaLabels.includes(label), `saw aria-label ${JSON.stringify(label)}`)
		);
	}
	for (const control of snapshot.controls) {
		const withinViewport = rectWithinViewport(control.rect, viewport);
		const clearsStatusBar = clearsStatusBarRect(
			control.rect,
			snapshot.statusBar?.visible ? snapshot.statusBar.rect : undefined
		);
		const clearsNotifications = clearsNotificationOverlays(control.rect, notificationOverlays);
		checks.push(
			check(
				`visible-${slug(control.ariaLabel)}`,
				control.visible && isPositiveRect(control.rect),
				`${control.ariaLabel}: ${formatRect(control.rect)}`
			)
		);
		checks.push(
			check(
				`viewport-${slug(control.ariaLabel)}`,
				withinViewport && clearsStatusBar && notificationOverlayBoundsValid && clearsNotifications,
				`${control.ariaLabel}: ${formatRect(control.rect)} in ${viewport.width}x${viewport.height}; ${
					clearsStatusBar ? 'clear of statusbar' : 'overlaps statusbar'
				}; ${clearsNotifications ? 'clear of notification overlays' : 'overlaps a notification overlay'}`
			)
		);
	}
	const start = snapshot.controls.find(control => control.ariaLabel === 'Start Agent run');
	const cancel = snapshot.controls.find(control => control.ariaLabel === 'Cancel Agent run');
	checks.push(check('start-enabled', start?.disabled === false, 'Start Agent is enabled while idle'));
	checks.push(check('cancel-disabled', cancel?.disabled === true, 'Cancel Agent is disabled while idle'));
	checks.push(check('ready-status', snapshot.status === 'Ready.', `status is ${JSON.stringify(snapshot.status)}`));
	checks.push(
		check(
			'keyboard-tab-order',
			arraysEqual(tabOrder, expectedAgentTabOrder),
			`tab order is ${JSON.stringify(tabOrder)}`
		)
	);
	checks.push(check('no-fatal-screen', snapshot.fatalScreen === false, 'Nyala fatal screen is absent'));
	return checks;
}

function check(id, passed, reason) {
	return { id, passed: Boolean(passed), reason };
}

function isPositiveRect(rect) {
	return (
		rect &&
		[rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(Number.isFinite) &&
		rect.width > 0 &&
		rect.height > 0 &&
		rect.right > rect.left &&
		rect.bottom > rect.top
	);
}

function rectWithinViewport(rect, viewport) {
	return (
		isPositiveRect(rect) &&
		rect.left >= 0 &&
		rect.right <= viewport.width &&
		rect.top >= 0 &&
		rect.bottom <= viewport.height
	);
}

function clearsStatusBarRect(controlRect, statusBarRect) {
	return !isPositiveRect(statusBarRect) || !rectsIntersect(controlRect, statusBarRect);
}

function clearsStatusBarRectWithTolerance(elementRect, statusBarRect) {
	return !isPositiveRect(statusBarRect) || !rectsIntersectWithTolerance(elementRect, statusBarRect, 0.1);
}

function clearsNotificationOverlays(controlRect, notificationOverlays) {
	return (
		Array.isArray(notificationOverlays) &&
		notificationOverlays.every(overlay => !rectsIntersect(controlRect, overlay?.rect))
	);
}

function rectsIntersect(left, right) {
	return (
		isPositiveRect(left) &&
		isPositiveRect(right) &&
		left.left < right.right &&
		left.right > right.left &&
		left.top < right.bottom &&
		left.bottom > right.top
	);
}

function rectsIntersectWithTolerance(left, right, tolerance) {
	return (
		isPositiveRect(left) &&
		isPositiveRect(right) &&
		left.left < right.right - tolerance &&
		left.right > right.left + tolerance &&
		left.top < right.bottom - tolerance &&
		left.bottom > right.top + tolerance
	);
}

function formatRect(rect) {
	return rect ? `${rect.left},${rect.top} ${rect.width}x${rect.height}` : 'missing';
}

function arraysEqual(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function slug(value) {
	return value
		.toLowerCase()
		.replaceAll(/[^a-z0-9]+/g, '-')
		.replaceAll(/(^-|-$)/g, '');
}
