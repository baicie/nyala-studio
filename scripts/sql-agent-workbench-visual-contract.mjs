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
  const controls = [...document.querySelectorAll('.sql-agent-view textarea, .sql-agent-view select, .sql-agent-view button')].map(element => ({
    tag: element.tagName,
    ariaLabel: element.getAttribute('aria-label') || '',
    disabled: Boolean(element.disabled),
    visible: visible(element),
    rect: rect(element)
  }));
  return {
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    userAgent: navigator.userAgent,
    workbenchReady: visible(document.querySelector('.monaco-workbench')),
    primarySidebarVisible: visible(document.querySelector('.part.sidebar')),
    agentRoot: { visible: visible(root), rect: rect(root) },
    ariaLabels: [...document.querySelectorAll('.sql-agent-view [aria-label]')].map(element => element.getAttribute('aria-label')),
    controls,
    status: document.querySelector('.sql-agent-status')?.textContent?.trim() || '',
    fatalScreen: document.body.innerText.includes('Nyala failed to start')
  };
})()`;
}

export function validateAgentWorkbenchSnapshot(snapshot, viewport, tabOrder) {
	const checks = [];
	checks.push(check('workbench-ready', snapshot.workbenchReady, 'Workbench root is visible'));
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
	checks.push(
		check('agent-root-bounds', isPositiveRect(snapshot.agentRoot?.rect), formatRect(snapshot.agentRoot?.rect))
	);
	for (const label of requiredAgentAriaLabels) {
		checks.push(
			check(`aria-${slug(label)}`, snapshot.ariaLabels.includes(label), `saw aria-label ${JSON.stringify(label)}`)
		);
	}
	for (const control of snapshot.controls) {
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
				control.rect.left >= 0 &&
					control.rect.right <= viewport.width &&
					control.rect.top >= 0 &&
					control.rect.bottom <= viewport.height,
				`${control.ariaLabel}: ${formatRect(control.rect)} in ${viewport.width}x${viewport.height}`
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
	return rect && rect.width > 0 && rect.height > 0;
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
