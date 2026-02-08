// ============================================================================
// TeammateService 测试
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { TeammateService, getTeammateService, resetTeammateService } from '../src/main/agent/teammate/teammateService';

describe('TeammateService', () => {
  let service: TeammateService;

  beforeEach(() => {
    resetTeammateService();
    service = getTeammateService();
  });

  describe('Agent Registration', () => {
    it('should register an agent', () => {
      service.register('agent-1', 'Coder', 'coder');

      const agent = service.getAgent('agent-1');
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('Coder');
      expect(agent?.role).toBe('coder');
      expect(agent?.status).toBe('idle');
    });

    it('should list all registered agents', () => {
      service.register('agent-1', 'Coder', 'coder');
      service.register('agent-2', 'Reviewer', 'reviewer');

      const agents = service.listAgents();
      expect(agents).toHaveLength(2);
    });

    it('should unregister an agent', () => {
      service.register('agent-1', 'Coder', 'coder');
      service.unregister('agent-1');

      expect(service.getAgent('agent-1')).toBeUndefined();
    });
  });

  describe('Message Sending', () => {
    beforeEach(() => {
      service.register('orchestrator', 'Orchestrator', 'orchestrator');
      service.register('coder', 'Coder Agent', 'coder');
      service.register('reviewer', 'Reviewer Agent', 'reviewer');
    });

    it('should send a coordination message', () => {
      const msg = service.coordinate('orchestrator', 'coder', 'Start implementing auth');

      expect(msg.id).toBeDefined();
      expect(msg.from).toBe('orchestrator');
      expect(msg.to).toBe('coder');
      expect(msg.type).toBe('coordination');
      expect(msg.content).toBe('Start implementing auth');
    });

    it('should deliver message to target inbox', () => {
      service.coordinate('orchestrator', 'coder', 'Start implementing auth');

      const inbox = service.getInbox('coder');
      expect(inbox).toHaveLength(1);
      expect(inbox[0].content).toBe('Start implementing auth');
    });

    it('should broadcast to all agents except sender', () => {
      service.send({
        from: 'orchestrator',
        to: 'all',
        type: 'broadcast',
        content: 'Project uses TypeScript',
      });

      const coderInbox = service.getInbox('coder');
      const reviewerInbox = service.getInbox('reviewer');
      const orchestratorInbox = service.getInbox('orchestrator');

      expect(coderInbox).toHaveLength(1);
      expect(reviewerInbox).toHaveLength(1);
      expect(orchestratorInbox).toHaveLength(0); // sender doesn't receive
    });

    it('should handle query and response', () => {
      const query = service.query('orchestrator', 'coder', 'What fields does User model have?');

      expect(query.type).toBe('query');
      expect(query.metadata?.requiresResponse).toBe(true);

      const response = service.respond('coder', 'orchestrator', 'id, name, email, password', query.id);

      expect(response.type).toBe('response');
      expect(response.metadata?.responseTo).toBe(query.id);
    });
  });

  describe('Conversation History', () => {
    beforeEach(() => {
      service.register('a', 'Agent A', 'agent');
      service.register('b', 'Agent B', 'agent');
      service.register('c', 'Agent C', 'agent');
    });

    it('should track conversation between two agents', () => {
      service.coordinate('a', 'b', 'Message 1');
      service.coordinate('b', 'a', 'Message 2');
      service.coordinate('a', 'c', 'Message to C');

      const conversation = service.getConversation('a', 'b');
      expect(conversation).toHaveLength(2);
    });

    it('should track message history', () => {
      service.coordinate('a', 'b', 'M1');
      service.coordinate('b', 'a', 'M2');
      service.coordinate('a', 'c', 'M3');

      const history = service.getHistory();
      expect(history).toHaveLength(3);
    });
  });

  describe('Event Subscription', () => {
    it('should notify on message received', () => {
      service.register('sender', 'Sender', 'agent');
      service.register('receiver', 'Receiver', 'agent');

      let receivedEvent: unknown = null;
      service.subscribe('receiver', (event) => {
        receivedEvent = event;
      });

      service.coordinate('sender', 'receiver', 'Hello');

      expect(receivedEvent).not.toBeNull();
      expect((receivedEvent as { type: string }).type).toBe('message:received');
    });

    it('should support unsubscribe', () => {
      service.register('sender', 'Sender', 'agent');
      service.register('receiver', 'Receiver', 'agent');

      let callCount = 0;
      const unsubscribe = service.subscribe('receiver', () => {
        callCount++;
      });

      service.coordinate('sender', 'receiver', 'M1');
      unsubscribe();
      service.coordinate('sender', 'receiver', 'M2');

      expect(callCount).toBe(1);
    });
  });

  describe('Statistics', () => {
    it('should track statistics', () => {
      service.register('a', 'A', 'agent');
      service.register('b', 'B', 'agent');
      service.coordinate('a', 'b', 'M1');
      service.coordinate('b', 'a', 'M2');

      const stats = service.getStats();
      expect(stats.agentCount).toBe(2);
      expect(stats.totalMessages).toBe(2);
    });
  });
});
