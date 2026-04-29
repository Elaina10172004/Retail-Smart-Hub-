import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface PageErrorBoundaryProps {
  children: React.ReactNode;
  resetKey: string;
}

interface PageErrorBoundaryState {
  error: Error | null;
}

export class PageErrorBoundary extends React.Component<PageErrorBoundaryProps, PageErrorBoundaryState> {
  state: PageErrorBoundaryState = {
    error: null,
  };

  static getDerivedStateFromError(error: Error): PageErrorBoundaryState {
    return { error };
  }

  componentDidUpdate(prevProps: PageErrorBoundaryProps) {
    if (prevProps.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    if (!this.state.error) {
      return this.props.children;
    }

    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-6 text-red-700 shadow-sm">
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-red-800">页面渲染失败</h2>
            <p className="mt-2 text-sm leading-6">
              当前页面出现运行时错误，已拦截白屏。错误信息：{this.state.error.message}
            </p>
            <Button
              type="button"
              variant="outline"
              className="mt-4 border-red-200 bg-white text-red-700 hover:bg-red-100"
              onClick={() => this.setState({ error: null })}
            >
              重试当前页面
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
