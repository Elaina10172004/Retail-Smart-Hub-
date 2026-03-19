import React, { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { confirmRecoverPassword, requestRecoverPassword } from '@/services/api/system';
import { KeyRound, LockKeyhole, LogIn, Package } from 'lucide-react';

interface LoginProps {
  onLogin: (username: string, password: string) => Promise<void>;
  isLoading: boolean;
}

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
      setRecoverMessage(response.message || '重置请求已受理，请使用一次性重置令牌完成改密。');
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
      setRecoverError('请填写重置令牌和新密码。');
      return;
    }

    if (recoverForm.newPassword !== recoverForm.confirmPassword) {
      setRecoverError('两次输入的新密码不一致。');
      return;
    }

    if (recoverForm.newPassword.trim().length < 8) {
      setRecoverError('新密码至少 8 位，并需满足复杂度要求。');
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
        username: current.username.trim(),
        email: current.email.trim(),
        phone: current.phone.trim(),
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
      <div className="grid gap-6 lg:grid-cols-[1.1fr_420px] max-w-6xl w-full">
        <div className="hidden lg:flex flex-col justify-center rounded-3xl border border-white/60 bg-white/50 backdrop-blur p-10 shadow-xl">
          <div className="inline-flex items-center gap-3 text-blue-700">
            <div className="h-12 w-12 rounded-2xl bg-blue-100 flex items-center justify-center">
              <Package className="h-6 w-6" />
            </div>
            <div>
              <div className="text-sm uppercase tracking-[0.24em] text-blue-500">Retail Smart Hub</div>
              <div className="text-3xl font-bold text-gray-900 mt-2">零售百货物流信息系统</div>
            </div>
          </div>

          <div className="mt-8 space-y-4 text-gray-700">
            <p>当前已接入订单、客户、库存、采购、到货、入库、发货、财务、报表、权限与基础资料模块。</p>
            <p>首次运行会自动生成管理员临时口令（一次性），用于进入系统完成初始化与改密。</p>
            <div className="rounded-2xl border border-blue-200 bg-blue-50/80 px-4 py-4">
              <div className="text-xs uppercase tracking-[0.18em] text-blue-500">Default Account</div>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                <div>
                  <div className="text-xs text-gray-500">用户名</div>
                  <div className="text-sm font-semibold text-gray-900">admin</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">密码</div>
                  <div className="text-sm font-semibold text-gray-900">首次启动时写入启动日志与数据目录下的 bootstrap-admin-password.txt</div>
                </div>
              </div>
              <div className="mt-3 text-xs text-gray-500">安装版如果没有控制台，请先查看 desktop.log 里记录的数据目录，再打开其中的 bootstrap-admin-password.txt。</div>
            </div>
            <p>找回密码采用“申请重置令牌 -&gt; 单次确认改密”的本地演示流程；生产环境如果需要自助找回，必须接入真实外部投递通道。</p>
          </div>
        </div>

        <Card className="border-gray-200 shadow-2xl bg-white/90 backdrop-blur">
          <CardHeader className="space-y-3">
            <div className="h-12 w-12 rounded-2xl bg-blue-100 text-blue-700 flex items-center justify-center">
              <LockKeyhole className="h-6 w-6" />
            </div>
            <div>
              <CardTitle className="text-2xl text-gray-900">登录系统</CardTitle>
              <p className="text-sm text-gray-500 mt-2">登录后才可以查看业务数据并执行受控操作。</p>
              <p className="text-xs text-blue-600 mt-2">首次启动：管理员临时口令会写入启动日志和数据目录中的 bootstrap-admin-password.txt（一次性）。</p>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
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

            {formError && <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{formError}</div>}

            <Button className="w-full bg-blue-600 hover:bg-blue-700 shadow-sm" onClick={() => void handleSubmit()} disabled={isLoading}>
              {isLoading ? <LockKeyhole className="mr-2 h-4 w-4 animate-pulse" /> : <LogIn className="mr-2 h-4 w-4" />}
              登录
            </Button>

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
                <Input value={recoverForm.phone} onChange={(e) => setRecoverForm({ ...recoverForm, phone: e.target.value })} placeholder="手机号" />
                <Input value={recoverForm.resetToken} onChange={(e) => setRecoverForm({ ...recoverForm, resetToken: e.target.value })} placeholder="重置令牌（收到后填写）" />
                <Input type="password" value={recoverForm.newPassword} onChange={(e) => setRecoverForm({ ...recoverForm, newPassword: e.target.value })} placeholder="新密码（至少 8 位，需满足复杂度）" />
                <Input type="password" value={recoverForm.confirmPassword} onChange={(e) => setRecoverForm({ ...recoverForm, confirmPassword: e.target.value })} placeholder="确认新密码" />
                {recoverTokenPreview ? (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                    <div className="font-medium">本地演示令牌预览</div>
                    <div className="mt-1 break-all font-mono text-xs">{recoverTokenPreview}</div>
                    <div className="mt-2 text-xs text-amber-700">当前为非生产环境，服务端直接返回了一次性重置令牌。请将它粘贴到上面的“重置令牌”输入框中完成改密。</div>
                  </div>
                ) : null}
                {recoverError ? <div className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{recoverError}</div> : null}
                {recoverMessage ? <div className="rounded-xl border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">{recoverMessage}</div> : null}
                <Button variant="outline" className="w-full" onClick={() => void handleRecoverRequest()} disabled={isRecovering}>
                  {isRecovering ? <LockKeyhole className="mr-2 h-4 w-4 animate-pulse" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  1) 申请重置令牌
                </Button>
                <Button variant="outline" className="w-full" onClick={() => void handleRecoverConfirm()} disabled={isRecovering}>
                  {isRecovering ? <LockKeyhole className="mr-2 h-4 w-4 animate-pulse" /> : <KeyRound className="mr-2 h-4 w-4" />}
                  2) 使用令牌重置密码
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
