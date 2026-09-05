import type * as React from 'react';
import {
  Area as RechartsArea,
  AreaChart as RechartsAreaChart,
  ReferenceLine as RechartsReferenceLine,
  ResponsiveContainer as RechartsResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis as RechartsXAxis,
  YAxis as RechartsYAxis,
} from 'recharts';

type RechartsComponent = React.ComponentType<any>;

export const Area = RechartsArea as unknown as RechartsComponent;
export const AreaChart = RechartsAreaChart as unknown as RechartsComponent;
export const ReferenceLine = RechartsReferenceLine as unknown as RechartsComponent;
export const ResponsiveContainer =
  RechartsResponsiveContainer as unknown as RechartsComponent;
export const Tooltip = RechartsTooltip as unknown as RechartsComponent;
export const XAxis = RechartsXAxis as unknown as RechartsComponent;
export const YAxis = RechartsYAxis as unknown as RechartsComponent;