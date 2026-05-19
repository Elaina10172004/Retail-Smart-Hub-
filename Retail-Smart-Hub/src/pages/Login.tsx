import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { confirmRecoverPassword, requestRecoverPassword } from '@/services/api/system';
import { KeyRound, LockKeyhole, LogIn, Package, UserCircle2 } from 'lucide-react';

interface LoginProps {
  onLogin: (username: string, password: string) => Promise<void>;
  isLoading: boolean;
}

interface DemoAccount {
  role: string;
  username: string;
  password: string;
  department: string;
  description: string;
}

const DEMO_ACCOUNTS: DemoAccount[] = [
  {
    role: '系统管理员',
    username: 'admin',
    password: 'admin',
    department: '管理部',
    description: '查看全部模块，维护角色权限、AI 配置和基础资料。',
  },
  {
    role: '运营经理',
    username: 'ops.chen',
    password: 'Demo@123',
    department: '运营部',
    description: '查看订单与报表，推进履约、库存、采购和发货链路。',
  },
  {
    role: '财务专员',
    username: 'finance.li',
    password: 'Demo@123',
    department: '财务部',
    description: '查看财务总览，处理应收、应付和对账。',
  },
  {
    role: '仓储主管',
    username: 'warehouse.zhang',
    password: 'Demo@123',
    department: '仓储部',
    description: '查看库存预警，处理入库、库存和发货执行。',
  },
  {
    role: '采购专员',
    username: 'buyer.wang',
    password: 'Demo@123',
    department: '采购部',
    description: '管理采购单、到货协同和供应商资料。',
  },
  {
    role: '客服与销售内勤',
    username: 'service.liu',
    password: 'Demo@123',
    department: '客服部',
    description: '跟进客户、订单和基础资料，适合演示对客场景。',
  },
];

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : '登录失败，请稍后重试。';
}

export function Login({ onLogin, isLoading }: LoginProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [formError, setFormError] = useState('');
  const [recoverMessage, setRecoverMessage] = useState('');
  const [recoverError, setRecoverError] = useState('');
  const [recoverTokenPreview, setRecoverTokenPreview] = useState('');
  const [showRecover, setShowRecover] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [recoverForm, setRecoverForm] = useState({
    username: '',
    email: '',
    phone: '',
    resetToken: '',
    newPassword: '',
    confirmPassword: '',
  });

  const fillDemoAccount = (account: DemoAccount) => {
    setUsername(account.username);
    setPassword(account.password);
    setFormError('');
  };

  const handleSubmit = async () => {
    setFormError('');

    if (!username.trim() || !password.trim()) {
      setFormError('请输入用户名和密码。');
      return;
    }

    try {
      await onLogin(username.trim(), password);
    } catch (error) {
      setFormError(getErrorMessage(error));
    }
  };

  const handleRecoverRequest = async () => {
    setRecoverError('');
    setRecoverMessage('');
    setRecoverTokenPreview('');

    if (!recoverForm.username.trim() || !recoverForm.email.trim()) {
      setRecoverError('请填写用户名和邮箱。');
      return;
    }

    setIsRecovering(true);
    try {
      const response = await requestRecoverPassword({
        username: recoverForm.username.trim(),
        email: recoverForm.email.trim(),
        phone: recoverForm.phone.trim(),
      });
      const tokenPreview = response.data?.resetTokenPreview?.trim() || '';
      if (tokenPreview) {
        setRecoverTokenPreview(tokenPreview);
      }
      setRecoverMessage(response.message || '重置请求已受理，请使用一次性口令完成改密。');
    } catch (error) {
      setRecoverError(getErrorMessage(error));
    } finally {
      setIsRecovering(false);
    }
  };

  const handleRecoverConfirm = async () => {
    setRecoverError('');
    setRecoverMessage('');

    if (!recoverForm.resetToken.trim() || !recoverForm.newPassword.trim()) {
      setRecoverError('请填写重置口令和新密码。');
      return;
    }

    if (recoverForm.newPassword !== recoverForm.confirmPassword) {
      setRecoverError('两次输入的新密码不一致。');
      return;
    }

    if (recoverForm.newPassword.trim().length < 8) {
      setRecoverError('新密码至少 8 位。');
      return;
    }

    setIsRecovering(true);
    try {
      const response = await confirmRecoverPassword({
        resetToken: recoverForm.resetToken.trim(),
        newPassword: recoverForm.newPassword,
      });
      setRecoverMessage(response.message || '密码已重置，请使用新密码登录。');
      setRecoverTokenPreview('');
      setRecoverForm((current) => ({
        ...current,
        resetToken: '',
        newPassword: '',
        confirmPassword: '',
      }));
    } catch (error) {
      setRecoverError(getErrorMessage(error));
    } finally {
      setIsRecovering(false);
    }
  };

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(37,99,235,0.18),_transparent_40%),linear-gradient(135deg,_#f8fafc_0%,_#e2e8f0_100%)] flex items-center justify-center px-4">
      <div className="grid gap-6 lg:grid-cols-[1.12fr_420px] max-w-6xl w-full">
        <div className="hidden lg:flex flex-col justify-center rounded-3xl border border-white/60 bg-white/50 backdrop-blur p-10 shadow-xl">
          <div className="inline-flex items-center gap-3 text-blue-700">
            <div className="h-12 w-12 rounded-2xl bg-blue-100 flex items-center justify-center">
              <Package className="h-6 w-6" />
            </div>
            <div>
              <div className="text-sm uppercase tracking-[0.24em] text-blue-500">Retail Smart Hub</div>
              <div className="mt-2 text-3xl font-bold text-gray-900">零售百货物流信息系统</div>
            </div>
          </div>

          <div className="mt-8 space-y-4 text-gray-700">
            <p>当前演示环境已经接入订单、客户、库存、采购、到货、入库、发货、财务、报表、权限与基础资料模块。</p>
            <p>下方账号均为演示账号，双击或单击卡片即可自动填充登录表单。</p>
          </div>

          <div className="mt-8 grid gap-3 md:grid-cols-2">
            {DEMO_ACCOUNTS.map((account) => (
              <button
                key={account.username}
                type="button"
                onClick={() => fillDemoAccount(account)}
                className="rounded-2xl border border-white/50 bg-white/70 px-4 py-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-blue-200 hover:bg-white"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-xs uppercase tracking-[0.18em] text-blue-500">{account.role}</div>
                    <div className="mt-2 text-lg font-semibold text-gray-900">{account.username}</div>
                  </div>
                  <UserCircle2 className="h-5 w-5 text-blue-500" />
                </div>
                <div className="mt-3 space-y-1 text-sm text-gray-600">
                  <div>密码：<span className="font-semibold text-gray-900">{account.password}</span></div>
                  <div>部门：{account.department}</div>
                  <div>{account.description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <Card className="border-gray-200 shadow-2xl bg-white/90 backdrop-blur">
          <CardHeader className="space-y-3">
            <div className="h-12 w-12 rounded-2xl bg-blue-100 text-blue-700 flex items-center justify-center">
              <LockKeyhole className="h-6 w-6" />
            </div>
            <div>
              <CardTitle className="text-2xl text-gray-900">登录系统</CardTitle>
              <p className="mt-2 text-sm text-gray-500">请输入账号和密码登录系统。</p>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="rounded-2xl border border-blue-200 bg-blue-50/80 p-4 lg:hidden">
              <div className="text-xs uppercase tracking-[0.18em] text-blue-500">演示账号</div>
              <div className="mt-3 grid gap-3">
                {DEMO_ACCOUNTS.map((account) => (
                  <button
                    key={account.username}
                    type="button"
                    onClick={() => fillDemoAccount(account)}
                    className="rounded-xl border border-blue-100 bg-white px-3 py-3 text-left"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="font-semibold text-gray-900">{account.username}</div>
                      <div className="text-xs text-blue-600">{account.role}</div>
                    </div>
                    <div className="mt-1 text-sm text-gray-600">密码：{account.password}</div>
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">用户名</label>
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="请输入用户名"
                className="border-gray-300 focus-visible:ring-blue-500"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium text-gray-700">密码</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="请输入密码"
                className="border-gray-300 focus-visible:ring-blue-500"
              />
            </div>

            {formError ? <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{formError}</div> : null}

            <Button className="w-full bg-blue-600 shadow-sm hover:bg-blue-700" onClick={() => void handleSubmit()} disabled={isLoading}>
              {isLoading ? <LockKeyhole className="mr-2 h-4 w-4 animate-pulse" /> : <LogIn className="mr-2 h-4 w-4" />}
              登录
            </Button>

            <div className="rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 text-xs text-gray-600">
              演示说明：`admin / admin` 为超管账号，其他演示账号统一使用 `Demo@123`。
            </div>

            <button
              type="button"
              className="w-full text-sm text-blue-600 hover:text-blue-700"
              onClick={() => {
                setShowRecover((current) => !current);
                setRecoverError('');
                setRecoverMessage('');
                setRecoverTokenPreview('');
              }}
            >
              {showRecover ? '收起找回密码' : '找回密码'}
            </button>

            {showRecover ? (
              <div className="space-y-3 rounded-2xl border border-gray-200 bg-gray-50 p-4">
                <div className="flex items-center gap-2 text-sm font-medium text-gray-800">
                  <KeyRound className="h-4 w-4 text-blue-600" />
                  账号找回
                </div>
                <Input value={recoverForm.username} onChange={(e) => setRecoverForm({ ...recoverForm, username: e.target.value })} placeholder="用户名" />
                <Input value={recoverForm.email} onChange={(e) => setRecoverForm({ ...recoverForm, email: e.target.value })} placeholder="邮箱" />
                <Input value={recoverForm.phone} onChange={(e) => setRecoverForm({ ...recoverForm, phone: e.target.value })} placeholder="手机号（选填）" />
                <Input value={recoverForm.resetToken} onChange={(e) => setRecoverForm({ ...recoverForm, resetToken: e.target.value })} placeholder="重置口令" />
                <Input type="password" value={recoverForm.newPassword} onChange={(e) => setRecoverForm({ ...recoverForm, newPassword: e.target.value })} placeholder="新密码（至少 8 位）" />
                <Input type="password" value={recoverForm.confirmPassword} onChange={(e) => setRecoverForm({ ...recoverForm, confirmPassword: e.target.value })} placeholder="确认新密码" />

                {recoverTokenPreview ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <div className="font-medium">重置口令预览</div>
                    <div className="mt-1 break-all font-mono text-xs">{recoverTokenPreview}</div>
                  </div>
                ) : null}
                {recoverError ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{recoverError}</div> : null}
                {recoverMessage ? <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{recoverMessage}</div> : null}

                <Button variant="outline" className="w-full" onClick={() => void handleRecoverRequest()} disabled={isRecovering}>
                  {isRecovering ? <LockKeyhole className="mr-2 h-4 w-4 animate-pulse" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  申请重置口令
                </Button>
                <Button variant="outline" className="w-full" onClick={() => void handleRecoverConfirm()} disabled={isRecovering}>
                  {isRecovering ? <LockKeyhole className="mr-2 h-4 w-4 animate-pulse" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  使用口令重置密码
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
