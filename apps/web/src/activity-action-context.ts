import { createContext, useContext } from 'react';

export const ActivityActionContext = createContext(false);
export const useActivityAction = () => useContext(ActivityActionContext);
