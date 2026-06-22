The public loop code is running on ubuntu@10.10.0.218. You have access via SSH.

The loop is running in ~/lawncare-saas on 10.10.0.218. 

## Language

**PRD-level quality gate**:
A review pass over the completed PRD branch after all currently known PRD issues have been processed. It checks the full PRD implementation against the branch starting commit and may create follow-up PRD issues before the loop stops for human review.
_Avoid_: Per-issue review, inline reviewer, normal review round

**Extra review round**:
One PRD-level quality gate cycle that runs after the known PRD issues have drained. A round may create follow-up PRD issues, after which the loop processes those issues before considering another extra review round.
_Avoid_: Coder round, reviewer attempt, issue round

**Independent review session**:
A PRD-level review run whose reviewer receives the shared PRD and branch comparison inputs but not the other reviewer session's context or conclusions.
_Avoid_: Shared review context, combined reviewer, chained reviewer

**Follow-up PRD issue**:
A ticket created from a PRD-level quality gate finding so the loop can continue improving the same PRD implementation without human re-triage.
_Avoid_: Draft issue, review note, backlog item

**Review base**:
The fixed commit-ish supplied by the operator that represents the starting point for PRD-level quality gates. Every extra review round compares the current PRD branch against this same point.
_Avoid_: Current base, merge base, default branch

**Completed PRD branch**:
The PRD branch after all currently eligible PRD issues have been processed and the validation gate is green. PRD-level quality gates review this accumulated branch state, not individual issue branches.
_Avoid_: Issue branch, work branch, partial PRD branch

**Escalation review round**:
A single terminal PRD-level quality gate that runs once, only after the bounded extra review rounds have cleanly exhausted and their follow-up PRD issues have drained. It uses a frontier review agent authenticated via host credentials, files follow-up PRD issues, lets the normal loop drain them once, and then the loop stops. It never re-runs itself.
_Avoid_: Extra review round, retry round, final loop

**Agent invocation livelock**:
A single agent run that remains active but repeats the same operation without making observable progress toward completion. It is distinct from an issue that fails across multiple review rounds.
_Avoid_: No-progress issue, stuck round, idle timeout

**Rework escalation**:
A retry of an issue attempt using the rework agent after the initial coder attempt fails, is rejected, or hits an agent invocation livelock. It may use the same model as the coder or a distinct configured rework model.
_Avoid_: Coder retry, model escalation, reviewer retry
