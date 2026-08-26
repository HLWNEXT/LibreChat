import { Calendar, User, Mail, Clock, Globe, Sparkles } from 'lucide-react';
import type { specialVariables } from 'librechat-data-provider';

type SpecialVariableKey = keyof typeof specialVariables;

export const specialVariableIcons: Record<
  SpecialVariableKey,
  React.ComponentType<{ className?: string }>
> = {
  current_date: Calendar,
  current_datetime: Clock,
  current_user: User,
  current_user_email: Mail,
  iso_datetime: Globe,
};

export const getSpecialVariableIcon = (name: string) =>
  specialVariableIcons[name as SpecialVariableKey] ?? Sparkles;
