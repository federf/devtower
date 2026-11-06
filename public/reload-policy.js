export const hasPendingWork = (state = {}, { draft = '', modalOpen = false } = {}) =>
  modalOpen || draft.trim() !== '' || Boolean(state.threadMutations?.size)
  || (state.tabs || []).some((tab) => tab.running || tab.draft?.trim() || tab.ctx?.length || tab.images?.length)
  || Object.values(state.replies || {}).some((reply) => reply.busy || (reply.open && reply.text?.trim()));
