'use strict';
/**
 * English catalogue - the canonical source of truth for every UI string.
 *
 * WHY ENGLISH IS THE BASE
 *   `t()` falls back to this file, and the completeness test measures every other locale against its key
 *   set. That makes this file the definition of "the UI", so a key added here and forgotten elsewhere
 *   shows up as a measurable gap rather than as a blank label.
 *
 * KEYS ARE SEMANTIC, NOT POSITIONAL. `goal.submit`, not `button1`. A key named after where a string
 * currently sits breaks the moment the layout changes, and layout changes are exactly when translations
 * get lost.
 *
 * WHAT IS NOT IN HERE, ON PURPOSE:
 *   - canonical machine values (`GOAL_COMPLETE`, `SEND_PENDING`, `DISABLED_BY_POLICY`). They appear under
 *     `status.*` as DISPLAY translations only; the values themselves are never rewritten.
 *   - provider names, transport identifiers, seat ids, task ids, run ids, hashes, file paths, git output,
 *     CLI commands and log lines. Translating those would make the product harder to audit, not easier to
 *     read.
 */

I18N.register('en', {
  // ---------------------------------------------------------------- header
  'app.title': 'EvidenceCrew',
  'header.harness': 'harness: ?',
  'header.harness.title': 'Harness health',
  'header.frozen': 'frozen: ?',
  'header.frozen.title': 'Freeze manifest drift check',
  'header.worker': 'worker: not probed',
  'header.worker.title': 'ChatGPT worker health (not probed until you ask)',
  'header.git.title': 'Project git state',
  'header.language': 'Language',
  'header.language.title': 'Interface language. Switching takes effect immediately and is remembered.',

  // ---------------------------------------------------------------- header actions
  'action.pause': 'Pause',
  'action.pause.title': 'Stop starting new automatic steps. An in-flight ChatGPT turn finishes; the browser is never killed.',
  'action.resume': 'Resume',
  'action.resume.title': 'Allow new automatic steps again',
  'action.probe': 'Probe worker',
  'action.probe.title': 'Ask the ChatGPT worker for a real health check (takes a few seconds)',
  'action.refresh': 'Refresh',
  'action.refresh.title': 'Re-read everything from the harness',
  'banner.paused': 'No new automated action will start. Running turns finish normally.',
  'autonomy.label': 'autonomy',
  'autonomy.title': 'ADVISOR: nothing runs without you. SAFE_AUTO: reserved for a later version and behaves identically in V0.1.',
  'view.advanced': 'Advanced view',
  'view.basic': 'Simple view',

  // ---------------------------------------------------------------- panels
  'panel.projects': 'Projects',
  'panel.workspaces': 'Workspaces',
  'panel.goal': 'Goal',
  'panel.tasks': 'Tasks',
  'panel.seats': 'Agent Team',
  'panel.run': 'Run',
  'panel.evidence': 'Evidence',
  'panel.humanInbox': 'Human seat inbox',
  'panel.now': 'Now',
  'panel.worker': 'Current worker',
  'panel.diff': 'Diff',
  'panel.timeline': 'Logs',

  // ---------------------------------------------------------------- goal
  'goal.prompt': 'What do you want your AI team to do?',
  'goal.placeholder': 'For example: check the login module for problems, and fix the code if needed.',
  'goal.submit': 'Start',
  'goal.hint': 'The planner reads the project state, then proposes tasks. Nothing is executed automatically.',
  'goal.selectProject': 'Select a project.',
  'goal.selectProjectWorkspace': 'Select a project and a workspace to begin.',
  'goal.selectWorkspace': 'Select a workspace first.',
  'goal.typeFirst': 'Type a goal first.',
  'goal.planning': 'Planning the goal…',
  'goal.planningDetail': 'The workspace worker is reading the project state and proposing tasks.',
  'goal.accepted': 'Goal {goalId} accepted, planning in workspace {workspace}.',
  'goal.planReady': 'Plan ready: {count} task(s) proposed. Review them, then start the ones you want.',
  'goal.blocked': 'Goal BLOCKED',
  'goal.noReason': 'no reason recorded',
  'goal.nothingRuns': 'Nothing runs by itself: press Start (or Send to worker) on the task you accept. Reject or ignore the rest.',
  'goal.parserNotes': 'Parser notes: {notes}',
  'goal.plannerNotes': 'Planner notes: {notes}',
  'goal.routedAs': 'routed as',

  // ---------------------------------------------------------------- guided goal: templates
  // The nine starting points. A template is a starting text the user edits, never a prompt the Workbench
  // sends on its own, and the file policy in guided-policy.js is what actually limits a run.
  'preset.inspect.title': 'Look into something first',
  'preset.inspect.desc': 'DeepSeek reads the project and reports what it finds. Nothing is changed. Good when you do not yet know what the problem is.',
  'preset.inspect.goal': 'Look through this project and tell me what you find. Do not change any file. Report what the problem is, where it is, and what you would do about it.',
  'preset.bugFix.title': 'Fix something broken',
  'preset.bugFix.desc': 'Something does not work as it should. The team finds the cause and proposes a fix. You approve each change before it is made.',
  'preset.bugFix.goal': 'Something is not working correctly. Find the cause first and show me what you would change. Ask me before you change any file. Do not do anything else at the same time.',
  'preset.feature.title': 'Add something new',
  'preset.feature.desc': 'Build new behaviour that fits the way the project is already written. DeepSeek may change the files in this workspace.',
  'preset.feature.goal': 'Add the following to this project, following the structure and style that are already here. Keep the change as small as it can be. Tell me what you changed and why.',
  'preset.refactor.title': 'Tidy up without changing behaviour',
  'preset.refactor.desc': 'Make the code easier to read or maintain while it keeps doing exactly what it does today. You approve each change.',
  'preset.refactor.goal': 'Make this easier to read and maintain, without changing what it does. Nothing user-visible may change. Ask me before you change any file.',
  'preset.tests.title': 'Add tests',
  'preset.tests.desc': 'Write tests for behaviour that already exists, so a later change cannot break it silently.',
  'preset.tests.goal': 'Write tests for the behaviour that is already there. Do not change the behaviour itself. If a test fails, report the failure instead of fixing the code.',
  'preset.docs.title': 'Write documentation',
  'preset.docs.desc': 'Document what the code does today, not what it was meant to do. DeepSeek checks the code first and writes from that.',
  'preset.docs.goal': 'Write documentation for this project. Read the code first, and describe what it does now, not what it was meant to do.',
  'preset.health.title': 'Get a health check',
  'preset.health.desc': 'A read-only report on the state of the project: what is fragile, what is duplicated, and what to work on next. Nothing is changed.',
  'preset.health.goal': 'Review the state of this project and tell me what to work on next. Do not change any file. Back every point with a concrete example from the code.',
  'preset.autonomous.title': 'Let it work for a while',
  'preset.autonomous.desc': 'Several rounds of work on one goal without stopping after every step. The budget is limited, and you approve each change.',
  'preset.autonomous.goal': 'Work on this goal for several rounds without stopping after every step. Keep going until it is finished or you are blocked, and ask me before you change any file.',
  'preset.custom.title': 'Something else',
  'preset.custom.desc': 'Write your own goal. Start read-only, and change the settings below if the work needs to write files.',
  'preset.exampleLabel': 'Starts with:',
  'guided.replaceConfirm': 'The goal box already contains text you may have written. Replace it with this template?',

  // ---------------------------------------------------------------- guided goal: the evidence summary
  // One plain sentence about a finished run, built from the Evidence Record's own element marks. The counts
  // are the record's, never an inference: a mark that was not recorded is counted as missing, not as a pass.
  'ev.summary.heading': 'What the evidence shows',
  // The three fixed answers, chosen from the record's own marks and status. The canonical status is never
  // replaced by these: it stays on screen beside them.
  'ev.summary.verified': 'Everything this result rests on is recorded and checks out.',
  'ev.summary.partial': 'Most of it is recorded, but not all of it - read the marks before you trust this.',
  'ev.summary.unverified': 'This result is NOT fully verified. Treat it as unproven until you have read the marks.',
  'ev.summary.missing': '{count} never recorded',
  'ev.summary.bad': '{count} recorded as a problem',

  // ---------------------------------------------------------------- guided goal: why a run stopped
  // The canonical stop status is NOT translated; these are the plain sentences shown BESIDE it.
  'plain.BLOCKED': 'The work stopped because something is in the way. It did not finish.',
  'plain.NO_PROGRESS': 'The work stopped because the last rounds were not getting anywhere.',
  'plain.BUDGET_EXHAUSTED': 'The work stopped because it reached the limit on how many rounds it may take.',
  'plain.USER_APPROVAL_REQUIRED': 'The work is waiting for your decision before it continues.',

  // ---------------------------------------------------------------- guided goal: file permission
  'file.heading': 'May the AI change my files?',
  'file.hint': 'This is enforced before anything runs, not just asked for in the prompt.',
  'file.readOnly': 'No - look only',
  'file.readOnly.desc': 'Nothing can be written. This is the safest choice and the right one for questions.',
  'file.write': 'Yes - it may write',
  'file.ask': 'Ask me first',
  'file.write.desc': 'The AI writes inside this workspace, within the existing limits. Nothing outside it is touched.',
  'file.ask.desc': 'The AI stops and waits for your decision before each write. Nothing is written until you approve it.',

  // ---------------------------------------------------------------- guided goal: autonomy
  'autonomy.heading': 'How often should it check with me?',
  'autonomy.guided': 'After every step',
  'autonomy.recommended': 'Balanced',
  'autonomy.autonomous': 'Let it keep going',
  'autonomy.guided.desc': 'It stops after each task and waits for you. The most control, the slowest.',
  'autonomy.recommended.desc': 'It plans the whole goal, then works through the tasks. It stops for your decisions and for the things it cannot do.',
  'autonomy.autonomous.desc': 'The same limits, but it does not wait between tasks. It still stops for your decisions, and the number of rounds is capped.',

  // ---------------------------------------------------------------- guided goal: review
  'review.heading': 'Who checks the work?',
  'review.supervisor': 'DeepSeek reviews the work',
  'review.supervisor.desc': 'The supervisor that planned the goal also checks the result. This costs nothing extra and is the default.',
  'review.codexAuto': 'Also ask Codex for a second opinion',
  'review.codexAuto.desc': 'For work that matters, an independent reviewer checks the result too. It costs more and takes longer, and it never blocks a goal on its own.',

  // ---------------------------------------------------------------- guided goal: preview
  'preview.heading': 'What this will do',
  // Shown while the policy is being resolved, and while a failure is reported instead of guessed at: a
  // read-only preview rendered because the policy could not be read would be the exact lie this layer avoids.
  'guided.loading': 'Checking what this will do...',
  'preview.failed': 'Could not read the policy, so nothing is promised here: {error}',
  /**
   * `autonomy.limits` was removed in V0.3.4.
   *
   * It labelled the collapsed loop-limits block, which is now driven by `intensity.budgets` - the budget block
   * gained the execution numbers and took over the disclosure, so the autonomy-only label had no reader left.
   * The i18n suite reports unreferenced keys as a warning, which is how it was noticed rather than shipped.
   */
  'preview.readSource': 'Read the project files it needs',
  'preview.splitTasks': 'Split the goal into tasks and work through them in order',
  'preview.supervisorReview': 'Have DeepSeek review the result',
  'preview.codexReview': 'Ask Codex for an independent review as well',
  'preview.noWrite': 'Change nothing at all: no file can be written',
  'preview.writeScoped': 'Write files inside this workspace, and nowhere else',
  'preview.askBeforeWrite': 'Ask you before every file change',
  'preview.stopLimits': 'Stop after every task and wait for you',

  // ---------------------------------------------------------------- V0.3.4 execution intensity
  //
  // The user-facing control. It sits UNDER autonomy and answers a different question: autonomy is how far the
  // run may go on its own, intensity is what it may spend. The two are independent, so every combination is
  // legal and the descriptions say what each one buys rather than what it forbids.
  'intensity.heading': 'How much should it spend?',
  'intensity.fast': 'Quick',
  'intensity.fast.desc': 'Call the AI as little as possible. Good for small edits and ordinary tasks.',
  'intensity.balanced': 'Balanced',
  'intensity.balanced.desc': 'Uses the worker and review according to how hard the task is. Recommended for everyday work.',
  'intensity.strict': 'Strict',
  'intensity.strict.desc': 'More independent checks and validation. For core changes and releases.',
  'intensity.recommended': '{name} (recommended)',

  // The budget readout, Advanced only. These are the real numbers the run is submitted with.
  'intensity.budgets': 'Execution budgets (technical)',
  'intensity.workerDispatches': 'worker dispatches per task',
  'intensity.retries': 'task retries',
  'intensity.reviews': 'supervisor reviews',
  'intensity.subagents': 'subagents',
  'intensity.validationTier': 'validation tier',
  'intensity.contextMode': 'context',
  'intensity.ceilingNote': 'These can only be tighter than the global safety limits, never looser.',

  // The two cost bands, interpolated from the resolved policy. Bands, not figures: see describeCostReport.
  'band.few': 'few',
  'band.moderate': 'moderate',
  'band.many': 'many',
  'band.basic': 'basic',
  'band.standard': 'standard',
  'band.strict': 'strict',
  'preview.workerDispatches': 'AI calls: {band}',
  'preview.validationTier': 'Validation: {band}',
  'preview.noTokenEstimate': 'No token estimate is shown, because nothing here measures tokens.',

  // The cost report shown when a goal finishes. Counts that were measured; no invented totals.
  'cost.heading': 'What this run used',
  'cost.supervisorTurns': 'Supervisor turns',
  'cost.workerTurns': 'Worker turns',
  'cost.reviewerTurns': 'Reviewer turns',
  'cost.subagents': 'Subagents',
  'cost.retries': 'Retries',
  'cost.validationTier': 'Validation tier',
  'cost.elapsed': 'Elapsed',
  'cost.tokens': 'Tokens',
  'cost.tokensNote': 'not measured',

  // ---------------------------------------------------------------- guided goal: empty state
  'guided.emptyTitle': 'No goal is running yet',
  'guided.emptyHint': 'Pick a starting point above, or type your own goal, then press Start. Examples:',
  // Shown before a project is chosen, when the examples cannot be used yet: their only effect is to fill the
  // goal box, and the Start button refuses without a project. Measured on a fresh profile: without this the
  // first screen a newcomer saw was an empty column.
  'guided.needProject': 'Choose a project on the left. Then pick a starting point above, or type your own goal.',
  'example.findBug': 'Find out why the login fails when the password is wrong.',
  'example.fixBug': 'The save button does not work. Find the cause and fix it, asking me before you change any file.',
  'example.addFeature': 'Add a dark mode toggle to the settings page.',
  'example.keepGoing': 'Work through the failing tests until they pass, one round at a time.',

  // ---------------------------------------------------------------- guided goal: onboarding
  'onboarding.title': 'How EvidenceCrew works',
  'onboarding.step1.title': '1. Say what you want in your own words',
  'onboarding.step1.desc': 'One sentence about the outcome is enough. You do not need to know how the work will be done. If you are not sure where to start, pick one of the starting points on the screen.',
  'onboarding.step2.title': '2. Choose how much the AI may touch',
  'onboarding.step2.desc': 'Three settings: whether it may change files, how often it stops to check with you, and who reviews the result. Each option says out loud what it will do.',
  'onboarding.step3.title': '3. Meet the team',
  'onboarding.step3.desc': 'DeepSeek is the supervisor: it reads your goal, splits it into tasks and reviews the result. ChatGPT is the worker: it does the actual work in your project. Codex is an optional second opinion that you can turn on for work that matters.',
  'onboarding.step4.title': '4. Press Start',
  'onboarding.step4.desc': 'The planner proposes tasks, and nothing runs until you accept one. Your files only change if you chose a setting that allows it, and you can stop the work at any time.',
  'onboarding.step5.title': '5. Read the evidence, not the promise',
  'onboarding.step5.desc': 'When the work finishes it produces an Evidence Record: what was read, what changed, what was tested and what failed. This records what actually happened, instead of trusting that the agent said done.',
  'onboarding.start': 'Start',
  'onboarding.skip': 'Skip this',
  'onboarding.reopen': 'Show this again',
  'onboarding.progress': '{step} / {total}',

  // ---------------------------------------------------------------- guided goal: contextual help
  'help.project.title': 'What is a project?',
  'help.project.desc': 'One codebase on this computer, registered with the harness. Its name and id never change, so the evidence always points at the same thing.',
  'help.workspace.title': 'What is a workspace?',
  'help.workspace.desc': 'A workspace is the slice of the project the AI is allowed to look at and change. Everything outside it stays invisible and untouchable. Normal use never needs it changed: it is one folder boundary, and you can forget it exists.',
  'help.seat.title': 'What is a seat?',
  'help.seat.desc': 'A seat is one role on the team. There are three: the supervisor (plans and reviews), the worker (does the work) and an optional reviewer (an independent check). Each seat keeps its own conversation and its own limits.',
  'help.task.title': 'What is a task?',
  'help.task.desc': 'The planner splits your goal into tasks. A task is one piece of work with its own state, and nothing runs until you accept it. A task finished by the AI is not the same as a task you approved.',
  'help.evidence.title': 'What is the Evidence Record?',
  'help.evidence.desc': 'One record per completed run: which files were read, what changed, which checks passed and what was never checked. A dash means not recorded, and it never means a pass.',
  'help.codex.title': 'What is the Codex reviewer?',
  'help.codex.desc': 'Codex is an optional second reviewer from a different provider. It is off by default and is not needed to use EvidenceCrew. Turning it on gives important work a second, independent opinion.',
  'help.goal.title': 'How do I write a goal?',
  'help.goal.desc': 'Say the outcome you want and what must not change. One or two sentences is enough, and naming the part of the project you mean helps. You do not need to describe how the work should be done: the planner works that out and shows you before anything runs.',

  // ---------------------------------------------------------------- tasks
  'task.showClosed': 'show closed',
  'task.none': 'No tasks here yet. Submit a Goal, or turn on "show closed".',
  'task.criteria': 'success criteria',
  'task.criteria.none': 'None recorded. The supervisor must define these before the task starts.',
  'task.history': 'history',
  'task.history.none': 'No history yet.',
  'task.retries': 'retries {count}',
  'task.modifiesFiles': 'modifies files',
  'task.noFileChanges': 'no file changes',
  'task.markInProgress': 'Mark in progress',
  'task.sendToWorker': 'Send to worker',
  'task.sendToWorker.title': 'Build the packet and send it to ChatGPT',
  'task.noWorker': 'No resolved worker in this workspace yet',
  'task.noWorkerConversation': 'This workspace has no resolved conversation',
  'task.toReview': 'To review',
  'task.movedToReview': 'moved to review',
  'task.done': 'Mark DONE and record the approval',
  'task.block': 'Block the task and record the rejection',
  'task.backToProgress': 'Back to IN_PROGRESS. The harness caps retries at 3.',
  'task.details': 'Details',
  'task.loadFailed': 'Cannot load task',
  'task.packetFailed': 'cannot build packet: {message}',
  'task.buildingPacket': 'building packet…',

  // ---------------------------------------------------------------- workspaces and projects
  'project.none': 'No projects registered. Register one with the harness CLI first.',
  'project.loadFailed': 'Cannot load project',
  'workspace.none': 'This project declares no workspaces.',
  'workspace.hint': 'Workspace = context boundary. The worker only receives this slice of the project.',
  'workspace.noWorker': 'no worker',
  'workspace.noGit': 'no git',
  'workspace.notGit': 'This project is not a git repository.',
  'nav.reloaded': 'Reloaded from the harness.',

  // ---------------------------------------------------------------- worker
  'worker.none': 'No worker in this workspace. A worker owns the ChatGPT conversation for this context boundary.',
  'worker.create': 'Create worker',
  'worker.creating': 'Creating worker…',
  'worker.created': 'Worker created.',
  'worker.notResolved': 'Its conversation is not resolved yet: press <em>Open conversation</em>.',
  'worker.openConversation': 'Open conversation',
  'worker.opening': 'Opening the conversation…',
  'worker.openingDetail': 'A browser window is being driven to bind a real conversation URL. This is the H1 lifecycle step.',
  'worker.rotate': 'Rotate worker',
  'worker.rotating': 'Rotating worker…',
  'worker.rotateConfirm': 'Rotate {workerId}? The old conversation is archived (never deleted) and a new worker takes over.\nReason:',
  'worker.rotated': 'Rotated. New worker: {workerId}.',
  'worker.needsOpening': 'Its conversation still needs opening before it can be used.',
  'worker.noneInWorkspace': 'No worker in that workspace.',
  'worker.noConversation': 'That worker has no resolved conversation yet. Use <em>Open conversation</em> first.',
  'worker.rotationRecommended': 'Rotation recommended: {reasons}',
  'worker.openLink': 'open the conversation',
  'worker.unresolvedUrl': 'Conversation URL is not resolved yet. Open it once to bind a real conversation.',

  // ---------------------------------------------------------------- run / job
  'run.idle': 'Idle',
  'run.noGoal': 'No goal is running.',
  'run.longTurn': 'A real ChatGPT turn can take a minute or two. The browser window is being driven for real; do not close it.',
  'run.projected': 'projected from existing logs at read time',

  // ---------------------------------------------------------------- send loop
  'send.confirm': 'Send this task to {workerId}?',
  'send.confirmDetail': 'A real browser window will be driven and ChatGPT will answer.',
  'send.confirmProposal': 'The answer is a proposal: nothing in your project is written until you approve it.',
  'send.starting': 'Starting the turn…',
  'send.waiting': 'Waiting for ChatGPT…',
  'send.waitingSeconds': 'Waiting for ChatGPT… {seconds}s',
  'send.working': '{workerId} is working.',
  'send.workingDetail': '{workerId} is working. This can take a minute or two.',
  'send.replyReceived': 'Reply received',
  'send.roundsNow': 'rounds now {rounds}',
  'send.turnCounted': 'Turn counted, but not completed',
  'send.nothingLanded': 'Nothing landed',
  'send.landedNote': 'The message landed, so the round was counted. Check the browser before retrying.',
  'send.notLandedNote': 'No round was counted. Check the browser window, then retry.',
  'send.lostContact': 'Lost contact with the turn',
  'send.stillRunning': 'Still running after 15 minutes.',
  'send.stillRunningDetail': 'Check the ChatGPT window. The turn was not cancelled.',
  'send.emptyReply': '(empty reply)',
  'send.readFailed': 'could not read the reply back: {message}',
  'send.noDetail': 'no detail',

  // ---------------------------------------------------------------- evidence
  'evidence.none': 'No Evidence Record selected. Every completed run produces one.',
  'evidence.noRecords': 'No records yet.',
  'evidence.headline.verified': 'Every load-bearing element is recorded and checks out.',
  'evidence.technical': 'Technical details',
  'evidence.technical.hint': 'Run identifiers, hashes and transport facts. Not needed to read the result; kept for auditing.',
  'evidence.detail.runId': 'Run id',
  'evidence.detail.taskId': 'Task id',
  'evidence.detail.seat': 'Seat',
  'evidence.detail.provider': 'Provider',
  'evidence.detail.transport': 'Transport',
  'evidence.detail.sourceHash': 'Source SHA-256',
  'evidence.detail.sourceSetHash': 'Source set hash',
  'evidence.detail.thread': 'Thread',
  'evidence.detail.turn': 'Turn',
  'evidence.detail.ack': 'Acknowledgement',
  'evidence.detail.commit': 'Commit',
  'evidence.notRecorded': 'Not recorded',
  'evidence.missing': 'Not recorded',
  'evidence.legacy': 'LEGACY_RUN',
  'evidence.legacy.short': 'LEGACY',

  // Evidence Card: element labels, keyed by the card's own element key, so a label follows the DATA rather
  // than the row position. The server keeps sending English labels; this replaces them for DISPLAY only,
  // and the server's own wording stays available in the row tooltip and in the technical drawer.
  'evidence.element.source_hash': 'Source identity',
  'evidence.element.worker_identity': 'Executor',
  'evidence.element.run_correlation': 'Run correlation',
  'evidence.element.source_ack': 'Source acknowledgement',
  'evidence.element.independent_review': 'Independent review',
  'evidence.element.approval': 'Approval',
  'evidence.element.write_scope': 'Write scope',
  'evidence.element.files_changed': 'Files changed',
  'evidence.element.diff_scope': 'Diff scope',
  'evidence.element.static_validation': 'Static validation',
  'evidence.element.runtime_validation': 'Runtime validation',
  'evidence.element.commit': 'Commit',

  // Evidence Card: the short verdict beside each label. Generic words first, then the ones that mean
  // something specific for one element. A verdict is DERIVED from the mark the server produced, so a
  // translated card cannot claim more than the record does.
  'evidence.verdict.ok': 'Confirmed',
  'evidence.verdict.bad': 'Problem',
  'evidence.verdict.absent': 'Not recorded',
  'evidence.verdict.na': 'Not applicable',
  'evidence.element.source_hash.ok': 'Recorded',
  'evidence.element.worker_identity.ok': 'Recorded',
  'evidence.element.run_correlation.ok': 'Confirmed',
  'evidence.element.run_correlation.bad': 'Not correlated',
  'evidence.element.source_ack.ok': 'Acknowledged',
  'evidence.element.source_ack.na': 'Nothing to acknowledge',
  'evidence.element.source_ack.bad': 'Could not be read',
  'evidence.element.independent_review.na': 'Disabled by policy',
  'evidence.element.independent_review.ok': 'Satisfied',
  'evidence.element.independent_review.bad': 'Not satisfied',
  'evidence.element.independent_review.absent': 'Not satisfied',
  'evidence.element.approval.ok': 'Approved',
  'evidence.element.write_scope.na': 'Read-only',
  'evidence.element.write_scope.ok': 'Restricted',
  'evidence.element.files_changed.ok': 'As required',
  'evidence.element.files_changed.bad': 'Outside the permitted scope',
  'evidence.element.diff_scope.ok': 'Within the permitted scope',
  'evidence.element.diff_scope.bad': 'Outside the permitted scope',
  'evidence.element.static_validation.ok': 'Passed',
  'evidence.element.static_validation.bad': 'Failed',
  'evidence.element.runtime_validation.ok': 'Passed',
  'evidence.element.runtime_validation.bad': 'Not performed',
  'evidence.element.commit.ok': 'Recorded',
  'evidence.rawValue': 'Value recorded by the server',
  'evidence.drawer.note': 'Transport thread and turn identifiers live in the Evidence Record JSON on disk. This view shows what the card projection carries.',
  'evidence.review.independent': 'Independent review',
  'evidence.review.supervisor': 'Supervisor review',
  'evidence.review.none': 'No review recorded',
  'evidence.canonicalHint': 'Machine value',

  // ---------------------------------------------------------------- evidence marks
  'mark.ok': 'Recorded and passed',
  'mark.bad': 'Recorded and failed',
  'mark.absent': 'Not recorded',
  'mark.na': 'Not applicable',

  // ---------------------------------------------------------------- runs and protocol panel
  'run.none': 'No run in this session. Open one to exercise the protocol.',
  'run.correlation': 'Correlation',
  'run.toctou': 'Source unchanged since dispatch',
  'run.notAttempted': 'not attempted',
  'run.sourceUnchanged': 'source unchanged',
  'run.notChecked': 'not checked',
  'run.independentReview': 'independent review',
  'run.noReview': 'no review',
  'run.notRecorded': 'not recorded',
  'run.rounds': 'rounds {count}',
  'human.none': 'No packets waiting for a human answer.',
  'human.pasteFirst': 'Paste an answer first.',
  'human.samePath': 'This answer goes through the SAME protocol path as a machine one.',
  'human.submitted': 'Answer submitted and correlated.',
  'human.noAck': 'no matching ack',

  // ---------------------------------------------------------------- codex reviewer
  'codex.label': 'Use Codex Reviewer',
  'codex.off': 'OFF',
  'codex.auto': 'AUTO',
  'codex.required': 'REQUIRED',
  'codex.title': 'OFF: Codex is not called; DeepSeek handles ordinary review. AUTO: important tasks may request an independent Codex review.',
  'codex.set': 'Codex reviewer set to {value}.',
  'codex.setEffective': 'Codex reviewer set to {value} (effective mode: {effective}).',
  'codex.offNote': 'The supervisor reviews its own work; records will say DISABLED_BY_POLICY, and no goal is blocked by it.',
  'codex.autoNote': 'An independent provider will be asked for where a second opinion changes the outcome.',
  'autonomy.set': 'Autonomy mode set to {value}.',
  'autonomy.safeAutoNote': 'Note: V0.1 has no auto-apply path at all, so this currently behaves exactly like ADVISOR.',
  'autonomy.advisorNote': 'Nothing runs without you.',

  // ---------------------------------------------------------------- seats
  'seat.none': 'No seats.',
  'seat.humanInbox': 'human seat: answers are pasted in',
  'seat.declaredNotConnected': 'declared, not connected',
  'seat.role.supervisor': 'Supervisor',
  'seat.role.supervisor.duty': 'plans and reviews',
  'seat.role.coder': 'Executor',
  'seat.role.coder.duty': 'coding and analysis',
  'seat.role.reviewer': 'Independent reviewer',
  'seat.role.human': 'Human',
  'seat.role.researcher': 'Researcher',
  'seat.state.idle': 'Idle',
  'seat.state.working': 'Working',
  'seat.disabled': 'Not enabled',
  'seat.disabled.policy': 'Off by policy',
  'seat.enable': 'Turn on',
  'seat.rounds': 'rounds {recorded}',
  'seat.roundsBudget': 'rounds {recorded}/{limit}',
  'seat.permissions.readOnly': 'read-only',
  'seat.permissions.writes': 'writes {paths}',

  // ---------------------------------------------------------------- logs, diff, timeline
  'logs.expand': 'Show',
  'logs.collapse': 'Hide',
  'logs.note': 'Log lines come from providers, the shell, git and the system. They are not translated.',
  'timeline.none': 'No events recorded for this project yet.',
  'diff.load': 'Load diff',
  'diff.notGit': 'This project is not a git repository.',

  // ---------------------------------------------------------------- errors and generic
  'error.server': 'cannot reach the workbench server: {message}',
  'error.startup': 'Startup failed',
  'error.refreshTasks': 'could not refresh task buttons',
  'error.protocolRefresh': 'protocol refresh failed',
  'error.loadCard': 'Cannot load card: {message}',
  'error.busy': 'Another operation is already running. Wait for it to finish.',
  'error.timeout': 'Operation timed out',
  'error.timeoutDetail': 'The request never completed. The workbench server may have stopped; check it and reload.',
  'error.quarantined': 'Answer quarantined',
  'common.refresh': 'Refresh',
  'common.cancel': 'Cancel',
  'common.ok': 'OK',
  'common.close': 'Close',
  'common.none': 'none',
  'error.failed': 'Failed',
  'toast.resumed': 'Resumed',
  'toast.resumedDetail': 'New steps may start again.',
  'toast.paused': 'Paused',
  'toast.workerCreated': 'Worker created.',
  'toast.replyReceived': 'Reply received',
  'toast.turnCounted': 'Turn counted, but not completed',
  'toast.nothingLanded': 'Nothing landed',
  'time.secondsAgo': '{count}s ago',
  'time.minutesAgo': '{count}m ago',
  'time.hoursAgo': '{count}h ago',
  'time.daysAgo': '{count}d ago',
  'decision.reason': '{label} {taskId} - reason (recorded in the task history, not a secret):',

  // ---------------------------------------------------------------- canonical machine values, DISPLAY ONLY
  // The values on the right are never written anywhere: the protocol, the JSON, the API and the tests keep
  // the canonical English. These entries exist so the UI can show a translated label beside it.
  'status.goal_complete': 'Goal complete',
  'status.blocked': 'Blocked',
  'status.send_pending': 'Waiting for send confirmation',
  'status.send_uncertain': 'Send state unknown',
  'status.user_turn_confirmed': 'Message delivered',
  'status.assistant_pending': 'Waiting for the answer',
  'status.idle': 'Idle',
  'status.submitting': 'Submitting',
  'status.complete': 'Complete',
  'status.disabled_by_policy': 'Disabled by policy',
  'status.supervisor_review': 'Supervisor review',
  'status.independent_provider_review': 'Independent provider review',
  'status.not_requested': 'Not requested',
  'status.requested': 'Requested',
  'status.unavailable': 'Unavailable',
  'status.satisfied': 'Satisfied',
  'status.not_satisfied': 'Not satisfied',
  'status.verified': 'Verified',
  'status.partial': 'Partial',
  'status.unverified': 'Unverified',
  'status.correlated': 'Correlated',
  'status.not_correlated': 'Not correlated',
  'status.completed': 'Completed',
  'status.awaiting_approval': 'Waiting for your approval',
  'status.in_progress': 'In progress',
  'status.todo': 'To do',
  'status.review': 'In review',
  'status.done': 'Done',
  'status.failed': 'Failed',
  'status.active': 'Active',
  'status.archived': 'Archived',
  'status.declared': 'Declared',
  'status.connected': 'Connected',
  'status.not_connected': 'Not connected',
  'status.unknown': 'Unknown',
  'status.ready': 'Ready',
  'status.error': 'Error',
  'status.new': 'New',
  'status.resolved': 'Resolved',
  'status.planning': 'Planning',
  'status.none': 'None',
  'codex.on': 'Auto',
  'task.count': '{shown} shown, {open} open',

  // ---- V0.3.3: the two beginner answers added on top of the panels the app already renders -------------
  //
  // The task explanation. `taskx.what/why/who/status/doneWhen` name the five facts a first-time user needs
  // in order to judge a task without knowing what a task id is; the id, type, priority and workspace stay in
  // the advanced-only meta row.
  'taskx.what': 'What',
  'taskx.why': 'Why',
  'taskx.who': 'Who',
  'taskx.status': 'Status',
  'taskx.doneWhen': 'Done when',
  'taskx.who.worker': 'Your AI teammate ({worker}) is working on this.',
  'taskx.who.none': 'No AI teammate is assigned to this workspace yet, so nothing will start on its own.',
  'taskx.noCriteria': 'This task has no completion criteria yet, so it cannot be finished or approved.',

  // The Evidence summary. `absent` and `warnings` are separate from `bad` on purpose: "recorded, and it is a
  // problem" and "not recorded at all" are different facts, and the summary must not merge them.
  'ev.summary.absent': '{count} item(s) were not recorded',
  'ev.summary.warnings': '{count} problem(s) were recorded',
});
