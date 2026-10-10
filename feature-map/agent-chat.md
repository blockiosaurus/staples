# Agent conversations and project handoff

A person can hold a persistent conversation with an agent, return to its history, and hand useful work into a project or task.

Implementation: [agent chat](../ui/src/pages/AgentChat.tsx), [chat landing](../ui/src/pages/AgentChats.tsx).

## Sub-features

- `discovery`: find an agent and reopen an accessible recent conversation.
- `history`: send messages, inspect replies/files, and return to the same conversation.
- `handoff`: create or identify a project/task from chat and follow the resulting work.

## How to get to it (user POV)

### `agent-conversation`

Open `/chats`, choose an agent, or use `/chats/:agentRef` and its conversation sidebar.

### `project-handoff`

Ask for project work in Agent Chat and follow its created project/task links.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Enable the applicable chat feature, use a configured test agent, and distinguish model replies from a mocked conversation fixture.

### `agent-conversation`

Automated: [chat landing](../ui/src/pages/AgentChats.test.tsx) checks recent-chat routing; [conversation service](../server/src/__tests__/agent-conversations.test.ts) covers persisted conversation behavior.

Manual: Start a conversation, send a recognizable request, and inspect its reply. Navigate away and reopen the same history. Test a new conversation, unavailable historical agent, and an inaccessible saved conversation; verify no cross-user or cross-company history appears.

### `project-handoff`

Automated: [chat project tools](../server/src/__tests__/chat-project-tools.test.ts) checks tool contracts; live model choice and UI handoff require a manual run.

Manual: Ask the configured agent to create bounded project work, inspect the proposed/created target, and open the resulting task. Verify the request context and intended project survived and the task produces a useful output.

## Gotchas

- Idle chat is not failed execution.
- See [steering](./steering.md) for in-flight messages and [questions](./questions-and-approvals.md) for interactions.
- An API tool test does not prove that every harness will choose the same handoff tool.
