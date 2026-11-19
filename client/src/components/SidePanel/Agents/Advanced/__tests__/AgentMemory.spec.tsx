import { FormProvider, useForm } from 'react-hook-form';
import { fireEvent, render, screen } from '@testing-library/react';
import type { UseFormReturn } from 'react-hook-form';
import type { AgentForm } from '~/common';
import AgentMemory from '../AgentMemory';

let mockShowMemory = true;
let mockGetValues: UseFormReturn<AgentForm>['getValues'];

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('../../Tools/hooks', () => ({ useShowMemory: () => mockShowMemory }));

function Harness({ memoryEnabled }: { memoryEnabled?: boolean }) {
  const methods = useForm<AgentForm>({ defaultValues: { memory_enabled: memoryEnabled } });
  mockGetValues = methods.getValues;
  return (
    <FormProvider {...methods}>
      <AgentMemory />
    </FormProvider>
  );
}

describe('AgentMemory', () => {
  beforeEach(() => {
    mockShowMemory = true;
  });

  it('renders nothing when memory is unavailable to the user', () => {
    mockShowMemory = false;
    const { container } = render(<Harness memoryEnabled={true} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('reflects an agent that has memory off', () => {
    render(<Harness memoryEnabled={false} />);
    expect(screen.getByRole('switch', { name: 'com_agents_memory_enabled' })).not.toBeChecked();
  });

  it('reflects an agent that has memory on', () => {
    render(<Harness memoryEnabled={true} />);
    expect(screen.getByRole('switch', { name: 'com_agents_memory_enabled' })).toBeChecked();
  });

  it('writes the new value to the form when toggled', () => {
    render(<Harness memoryEnabled={false} />);
    const toggle = screen.getByRole('switch', { name: 'com_agents_memory_enabled' });
    fireEvent.click(toggle);
    expect(mockGetValues('memory_enabled')).toBe(true);
    fireEvent.click(toggle);
    expect(mockGetValues('memory_enabled')).toBe(false);
  });
});
