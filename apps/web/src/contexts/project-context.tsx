import { createContext, useContext } from 'react';
import { useParams, Navigate } from 'react-router-dom';
import { useProject, type Project } from '@/hooks/use-projects';

interface ProjectContextValue {
  projectId: string;
  project: Project | undefined;
  isLoading: boolean;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectContextProvider({ children }: { children: React.ReactNode }) {
  const { projectId } = useParams<{ projectId: string }>();
  const { data: project, isLoading, error } = useProject(projectId);

  if (!projectId) {
    return <Navigate to="/projects" replace />;
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  if (error || (!isLoading && !project)) {
    return <Navigate to="/projects" replace />;
  }

  return (
    <ProjectContext.Provider value={{ projectId, project, isLoading }}>
      {children}
    </ProjectContext.Provider>
  );
}

export function useCurrentProject(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) {
    throw new Error('useCurrentProject must be used within a ProjectContextProvider');
  }
  return context;
}
