import { Controller, useFormContext } from 'react-hook-form';
import type { AgentForm } from '~/common';
import { useShowMemory } from '../Tools/hooks';
import { useLocalize } from '~/hooks';
import { ToggleSetting } from './ui';

/** Per-agent opt in to memory. Hidden when memory is unavailable to the user. */
export default function AgentMemory() {
  const localize = useLocalize();
  const showMemory = useShowMemory();
  const { control } = useFormContext<AgentForm>();

  if (!showMemory) {
    return null;
  }

  return (
    <Controller
      name="memory_enabled"
      control={control}
      render={({ field }) => (
        <ToggleSetting
          id="agent-memory-enabled"
          label={localize('com_agents_memory_enabled')}
          checked={field.value === true}
          onCheckedChange={field.onChange}
          info={<p>{localize('com_agents_memory_enabled_info')}</p>}
        />
      )}
    />
  );
}
