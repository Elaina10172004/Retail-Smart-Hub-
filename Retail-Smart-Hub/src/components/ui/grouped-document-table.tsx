import React from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

export interface GroupedDocumentTableColumn<TGroup> {
  key: string;
  header: React.ReactNode;
  headerClassName?: string;
  cellClassName?: string;
  renderCell: (group: TGroup) => React.ReactNode;
}

interface GroupedDocumentTableProps<TGroup> {
  groups: TGroup[];
  columns: GroupedDocumentTableColumn<TGroup>[];
  getGroupId: (group: TGroup) => string;
  expandedGroupIds: string[];
  onToggleGroup: (groupId: string) => void;
  renderExpandedContent: (group: TGroup) => React.ReactNode;
  showSelectionCheckbox?: boolean;
  isGroupSelected?: (group: TGroup) => boolean;
  isGroupIndeterminate?: (group: TGroup) => boolean;
  onToggleGroupSelected?: (group: TGroup, checked: boolean) => void;
  isGroupSelectionDisabled?: (group: TGroup) => boolean;
  loading?: boolean;
  loadingText?: string;
  emptyText?: string;
  className?: string;
}

export function GroupedDocumentTable<TGroup>({
  groups,
  columns,
  getGroupId,
  expandedGroupIds,
  onToggleGroup,
  renderExpandedContent,
  showSelectionCheckbox = true,
  isGroupSelected,
  isGroupIndeterminate,
  onToggleGroupSelected,
  isGroupSelectionDisabled,
  loading = false,
  loadingText = '正在加载...',
  emptyText = '暂无数据。',
  className,
}: GroupedDocumentTableProps<TGroup>) {
  const showSelection = showSelectionCheckbox && Boolean(onToggleGroupSelected);
  const totalColumns = columns.length + (showSelection ? 2 : 1);

  return (
    <div className={cn('overflow-x-auto rounded-xl border border-gray-200', className)}>
      <Table>
        <TableHeader>
          <TableRow className="bg-gray-50/80 hover:bg-gray-50/80">
            {showSelection ? <TableHead className="w-10 px-2 py-1 text-center font-semibold text-gray-900" /> : null}
            {columns.map((column) => (
              <TableHead key={column.key} className={cn('px-2.5 py-1 font-semibold text-gray-900', column.headerClassName)}>
                {column.header}
              </TableHead>
            ))}
            <TableHead className="w-10 px-2 py-1 text-center font-semibold text-gray-900" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={totalColumns} className="h-16 text-center text-sm text-gray-500">
                {loadingText}
              </TableCell>
            </TableRow>
          ) : null}
          {!loading && groups.length === 0 ? (
            <TableRow>
              <TableCell colSpan={totalColumns} className="h-16 text-center text-sm text-gray-500">
                {emptyText}
              </TableCell>
            </TableRow>
          ) : null}
          {!loading &&
            groups.map((group) => {
              const groupId = getGroupId(group);
              const expanded = expandedGroupIds.includes(groupId);
              const selected = isGroupSelected?.(group) ?? false;
              const indeterminate = isGroupIndeterminate?.(group) ?? false;
              const disabled = isGroupSelectionDisabled?.(group) ?? false;

              return (
                <React.Fragment key={groupId}>
                  <TableRow className="bg-white hover:bg-blue-50/30">
                    {showSelection ? (
                      <TableCell className="px-2 py-1 text-center align-middle">
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                          checked={selected}
                          disabled={disabled}
                          ref={(node) => {
                            if (node) {
                              node.indeterminate = !selected && indeterminate;
                            }
                          }}
                          onChange={(event) => onToggleGroupSelected?.(group, event.target.checked)}
                          aria-label="勾选整张单据"
                        />
                      </TableCell>
                    ) : null}
                    {columns.map((column) => (
                      <TableCell key={column.key} className={cn('px-2.5 py-1 align-middle', column.cellClassName)}>
                        {column.renderCell(group)}
                      </TableCell>
                    ))}
                    <TableCell className="px-2 py-1 text-center align-middle">
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-gray-200 bg-white text-gray-500 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-600"
                        onClick={() => onToggleGroup(groupId)}
                        aria-label={expanded ? '收起明细' : '展开明细'}
                      >
                        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </button>
                    </TableCell>
                  </TableRow>
                  {expanded ? (
                    <TableRow className="bg-gray-50/40 hover:bg-gray-50/40">
                      <TableCell colSpan={totalColumns} className="p-0">
                        {renderExpandedContent(group)}
                      </TableCell>
                    </TableRow>
                  ) : null}
                </React.Fragment>
              );
            })}
        </TableBody>
      </Table>
    </div>
  );
}
