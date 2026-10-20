/** Serializable contracts shared by desktop, MCP and main-process coordination. */
export type IntegrationPolicy = 'review' | 'automatic';
export type SessionProfile = 'ordinary' | 'child-review' | 'child-automatic';
export interface SessionCapabilities {
  profile: SessionProfile;
  canCreate: boolean;
  peers: boolean;
}

export interface SessionCaller {
  taskId: string;
  agentId: string;
  sessionInstanceId: string;
  capabilities: SessionCapabilities;
}

export interface TaskAuthorityInput {
  taskId: string;
  name: string;
  projectId: string;
  projectRoot: string;
  worktreePath: string;
  branchName: string;
  gitIsolation: 'worktree' | 'direct' | 'none';
  parentTaskId?: string;
  coordinatorMode?: boolean;
  autoMergeChildren?: boolean;
  autoSendChildUpdates?: boolean;
  delegationParent?: boolean;
  propagateSkipPermissions?: boolean;
  externalWorktree?: boolean;
  integrationPolicy?: IntegrationPolicy;
  delegationPaused?: boolean;
  agentCommand: string;
  agentArgs: string[];
  agentEnvFile?: string;
  dockerMode?: boolean;
  dockerImage?: string;
  verifyCommand?: string;
  maxConcurrentTasks?: number;
}

export interface ProjectDelegationPolicy {
  projectId: string;
  allowPeerAccess: boolean;
}

export interface DelegationSnapshot {
  branchName: string;
  headSha: string;
  changedFileCount: number;
}

export interface DelegateAssignment {
  parentTaskId: string;
  requestId: string;
  name: string;
  prompt: string;
  expectedBranch: string;
  expectedHeadSha: string;
  useLastCommit: boolean;
  /** Branch from the parent's committed snapshot and land on the parent branch instead of main. */
  baseOnParent?: boolean;
  agentCommand?: string;
  agentArgs?: string[];
  agentEnvFile?: string;
  propagateSkipPermissions?: boolean;
}

export interface DelegationAttempt {
  requestId: string;
  parentTaskId: string;
  name: string;
  status: 'starting' | 'failed' | 'created';
  taskId?: string;
  error?: string;
}

export interface PeerSession {
  agentId: string;
  sessionInstanceId: string;
  taskId: string;
  name: string;
  agentLabel: string;
  branchName: string;
  status: string;
}

export interface PeerMessage {
  deliveryId: string;
  /** Missing on existing agent-origin peer messages. */
  origin?: 'user';
  sender: PeerSession;
  recipient: PeerSession;
  prompt: string;
  createdAt: string;
  state: 'waiting' | 'delivered' | 'handled' | 'closed';
  reason?: string;
  /** Keep a failed automatic submission visible until the user acknowledges it. */
  deliveryFailed?: boolean;
}

export type DelegationRequest =
  | { action: 'register'; task: TaskAuthorityInput }
  | { action: 'unregister'; taskId: string }
  | { action: 'projectPolicy'; policy: ProjectDelegationPolicy }
  | { action: 'orchestrationSetting'; enabled: boolean }
  | { action: 'pause'; taskId: string; paused: boolean }
  | { action: 'childLimit'; taskId: string; limit: number }
  | { action: 'inbox'; taskId: string }
  | { action: 'handoffSessions'; taskId: string }
  | {
      action: 'handoff';
      taskId: string;
      sourceAgentId: string;
      sourceSessionInstanceId: string;
      agentId: string;
      sessionInstanceId: string;
      prompt: string;
      requestId: string;
    }
  | { action: 'dismissMessageFailure'; deliveryId: string }
  | {
      action: 'deliverMessage';
      deliveryId: string;
      agentId: string;
      sessionInstanceId: string;
    }
  | {
      action: 'handleMessage';
      deliveryId: string;
      agentId: string;
      sessionInstanceId: string;
      state: 'handled' | 'closed';
    }
  | { action: 'dismissAttempt'; parentTaskId: string; requestId: string }
  | { action: 'state'; taskId: string }
  | { action: 'closeParent'; taskId: string; deleteBranch?: boolean }
  | { action: 'detachChild'; taskId: string };

export interface DelegationState {
  attempts: DelegationAttempt[];
  messages: PeerMessage[];
  paused: boolean;
}

export type DelegationChanged =
  | { taskId: string; state: DelegationState }
  | {
      taskId: string;
      detachedChildIds: string[];
      /** Missing means paused: children orphaned by a closed parent need review first. */
      paused?: boolean;
    };
