/** A single, predictable in-flight tool window. HUD display modes never change the user's open tool. */
export type FlightTool = 'navigation' | 'autopilot' | 'radio' | 'camera' | 'display';
export type NavigationTab = 'map' | 'plan';
export interface FlightWorkspace {
  tool: FlightTool | null;
  navigationTab: NavigationTab;
  minimized: boolean;
}
export type WorkspaceAction =
  | { type: 'toggle'; tool: FlightTool }
  | { type: 'navigation'; tab: NavigationTab }
  | { type: 'minimize' }
  | { type: 'restore' }
  | { type: 'close' };

export const INITIAL_WORKSPACE: FlightWorkspace = { tool: null, navigationTab: 'map', minimized: false };

export function flightWorkspaceReducer(state: FlightWorkspace, action: WorkspaceAction): FlightWorkspace {
  switch (action.type) {
    case 'toggle':
      return { ...state, tool: state.tool === action.tool && !state.minimized ? null : action.tool, minimized: false };
    case 'navigation':
      return { tool: 'navigation', navigationTab: action.tab, minimized: false };
    case 'minimize': return state.tool ? { ...state, minimized: !state.minimized } : state;
    case 'restore': return { ...state, minimized: false };
    case 'close': return { ...state, tool: null, minimized: false };
  }
}
