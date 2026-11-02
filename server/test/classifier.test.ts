import { describe, expect, it } from 'vitest';
import { classify } from '../src/tasks/classifier.ts';

const projects = [{ id: 'p1', name: 'ClientEasy' }, { id: 'p2', name: 'Northwind Dental' }];

describe('classifier', () => {
  it('picks type, project and effort from rules', () => {
    expect(classify('Fix the login bug in ClientEasy', projects)).toMatchObject({ type: 'code', projectId: 'p1' });
    expect(classify('Research the best Postgres backup tools', projects)).toMatchObject({ type: 'research', projectId: null });
    expect(classify('Draft a blog post about our launch for northwind dental', projects)).toMatchObject({ type: 'write', projectId: 'p2' });
    expect(classify('Remember that Sam prefers calls on Tuesdays', projects).type).toBe('memory');
    expect(classify('Migrate the whole ClientEasy codebase to the new architecture', projects).effort).toBe('high');
    expect(classify('Fix a typo', projects).effort).toBe('low');
  });

  it('flags outward-facing work', () => {
    expect(classify('Send the invoice to Priya', projects).outward).toBe(true);
    expect(classify('Summarise my unread email', projects).outward).toBe(false);
  });
});
