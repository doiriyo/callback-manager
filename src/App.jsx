import { useState, useEffect, useCallback } from 'react'

const GAS_URL = import.meta.env.VITE_GAS_URL
const GAS_API_KEY = import.meta.env.VITE_GAS_API_KEY || ''

function gasPost(body) {
  return fetch(GAS_URL, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ ...body, api_key: GAS_API_KEY }),
  })
}

async function fetchCallbacks() {
  const body = { action: 'get_callbacks', api_key: GAS_API_KEY }
  const res = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return data.records || []
}

function toLocalDatetime() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const SESSION_KEY = 'callback_session'
const SESSION_TTL = 12 * 60 * 60 * 1000 // 12時間

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    if (Date.now() - s.timestamp > SESSION_TTL) {
      localStorage.removeItem(SESSION_KEY)
      return null
    }
    return s.name
  } catch { return null }
}

function saveSession(name) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ name, timestamp: Date.now() }))
}

function groupByPhone(records) {
  const map = {}
  for (const r of records) {
    const phone = String(r.phone || '')
    if (!map[phone]) {
      map[phone] = { phone, customer_name: r.customer_name, entries: [] }
    }
    map[phone].entries.push(r)
    // 最新の顧客名で更新
    if (r.customer_name) map[phone].customer_name = r.customer_name
  }
  return Object.values(map)
}

export default function App() {
  const [operatorName, setOperatorName] = useState(() => loadSession() || '')
  const [loginInput, setLoginInput] = useState('')
  const isLoggedIn = !!operatorName

  const [records, setRecords] = useState([])
  const [filterPending, setFilterPending] = useState(true)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [selectedPhone, setSelectedPhone] = useState(null)

  // Form state
  const [phone, setPhone] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [assignee, setAssignee] = useState(() => loadSession() || '')
  const [memo, setMemo] = useState('')
  const [datetime, setDatetime] = useState(toLocalDatetime())

  const handleLogin = () => {
    const name = loginInput.trim()
    if (!name) return
    saveSession(name)
    setOperatorName(name)
    setAssignee(name)
    setLoginInput('')
  }

  const handleLogout = () => {
    localStorage.removeItem(SESSION_KEY)
    setOperatorName('')
  }

  const loadRecords = useCallback(async () => {
    try {
      setLoading(true)
      const data = await fetchCallbacks()
      setRecords(data)
    } catch (e) {
      console.error('取得エラー:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadRecords()
    const interval = setInterval(loadRecords, 30000)
    return () => clearInterval(interval)
  }, [loadRecords])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    try {
      await gasPost({
        action: 'add_callback',
        phone,
        customer_name: customerName,
        assignee,
        memo,
      })
      setPhone('')
      setCustomerName('')
      setAssignee(operatorName)
      setMemo('')
      setDatetime(toLocalDatetime())
      setTimeout(loadRecords, 1500)
    } catch (e) {
      console.error('登録エラー:', e)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDone = async (id) => {
    try {
      await gasPost({ action: 'update_callback', id, status: 'done', operator: operatorName })
      setTimeout(loadRecords, 1500)
    } catch (e) {
      console.error('更新エラー:', e)
    }
  }

  // グループ化 & フィルタリング
  const groups = groupByPhone(records)
  const filteredGroups = groups.filter((g) => {
    const hasPending = g.entries.some((e) => e.status === 'pending')
    if (filterPending && !hasPending) return false
    if (search) {
      const q = search.toLowerCase()
      if (!String(g.phone).toLowerCase().includes(q) && !String(g.customer_name || '').toLowerCase().includes(q)) return false
    }
    return true
  }).sort((a, b) => {
    // 最新の未対応エントリのcreated_atでソート（新しい順）
    const latestA = a.entries.filter((e) => e.status === 'pending').sort((x, y) => (y.created_at || '').localeCompare(x.created_at || ''))[0]
    const latestB = b.entries.filter((e) => e.status === 'pending').sort((x, y) => (y.created_at || '').localeCompare(x.created_at || ''))[0]
    const dateA = latestA?.created_at || a.entries[a.entries.length - 1]?.created_at || ''
    const dateB = latestB?.created_at || b.entries[b.entries.length - 1]?.created_at || ''
    return dateB.localeCompare(dateA)
  })

  // 選択中の顧客のログ
  const selectedGroup = selectedPhone ? groups.find((g) => g.phone === selectedPhone) : null
  const selectedEntries = selectedGroup
    ? [...selectedGroup.entries].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
    : []

  // サマリー
  const pendingPhones = groups.filter((g) => g.entries.some((e) => e.status === 'pending')).length
  const todayStr = new Date().toISOString().slice(0, 10)
  const todayCount = records.filter((r) => (r.created_at || '').slice(0, 10) === todayStr && !(r.memo || '').startsWith('【ステータス変更】')).length
  const donePhones = groups.filter((g) => g.entries.every((e) => e.status === 'done')).length

  if (!isLoggedIn) {
    return (
      <div className="login-page">
        <div className="login-box">
          <h1>コールバック管理</h1>
          <p className="login-desc">担当者名を入力してログイン</p>
          <input
            type="text"
            placeholder="名前を入力"
            value={loginInput}
            onChange={(e) => setLoginInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleLogin()}
            autoFocus
          />
          <button className="btn-primary" onClick={handleLogin} disabled={!loginInput.trim()}>
            ログイン
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>コールバック管理</h1>
        <div className="summary">
          <div className="card pending-card">
            <div className="card-value">{pendingPhones}</div>
            <div className="card-label">未対応</div>
          </div>
          <div className="card today-card">
            <div className="card-value">{todayCount}</div>
            <div className="card-label">本日登録</div>
          </div>
          <div className="card done-card">
            <div className="card-value">{donePhones}</div>
            <div className="card-label">対応済</div>
          </div>
        </div>
        <div className="user-info">
          <span className="user-name">{operatorName}</span>
          <button className="btn-logout" onClick={handleLogout}>ログアウト</button>
        </div>
      </header>

      <div className="columns">
        {/* 左: 新規登録 */}
        <div className="col col-form">
          <div className="panel">
            <h2>新規登録</h2>
            <form onSubmit={handleSubmit}>
              <input type="tel" placeholder="電話番号 *" value={phone} onChange={(e) => setPhone(e.target.value)} required />
              <input type="text" placeholder="顧客名 *" value={customerName} onChange={(e) => setCustomerName(e.target.value)} required />
              <input type="text" placeholder="担当者名 *" value={assignee} onChange={(e) => setAssignee(e.target.value)} required />
              <textarea placeholder="用件メモ *" value={memo} onChange={(e) => setMemo(e.target.value)} required rows={3} />
              <input type="datetime-local" value={datetime} onChange={(e) => setDatetime(e.target.value)} />
              <button type="submit" className="btn-primary" disabled={submitting}>
                {submitting ? '登録中...' : '登録する'}
              </button>
            </form>
          </div>
        </div>

        {/* 中央: 要対応リスト */}
        <div className="col col-list">
          <div className="panel">
            <h2>要対応リスト</h2>
            <div className="list-controls">
              <div className="filter-toggle">
                <button className={filterPending ? 'active' : ''} onClick={() => setFilterPending(true)}>未対応</button>
                <button className={!filterPending ? 'active' : ''} onClick={() => setFilterPending(false)}>全件</button>
              </div>
              <input type="text" className="search-input" placeholder="検索..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>

            {loading && records.length === 0 && <p className="empty">読み込み中...</p>}
            {filteredGroups.length === 0 && !loading && <p className="empty">該当なし</p>}

            <div className="group-list">
              {filteredGroups.map((g) => {
                const pendingCount = g.entries.filter((e) => e.status === 'pending').length
                const totalCount = g.entries.filter((e) => !(e.memo || '').startsWith('【ステータス変更】')).length
                const isSelected = selectedPhone === g.phone
                const hasPending = pendingCount > 0
                return (
                  <div
                    key={g.phone}
                    className={`group-item ${isSelected ? 'selected' : ''} ${hasPending ? 'has-pending' : 'all-done'}`}
                    onClick={() => setSelectedPhone(isSelected ? null : g.phone)}
                  >
                    <div className="group-header">
                      <span className="group-name">{g.customer_name}</span>
                      {hasPending && <span className="badge badge-pending">{pendingCount}件未対応</span>}
                      {!hasPending && <span className="badge badge-done">対応済</span>}
                    </div>
                    <div className="group-phone">{g.phone}</div>
                    <div className="group-meta">対応履歴 {totalCount}件</div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>

        {/* 右: 対応ログ */}
        <div className="col col-log">
          <div className="panel">
            {selectedGroup ? (
              <>
                <div className="log-header">
                  <h2>{selectedGroup.customer_name}</h2>
                  <div className="log-phone">{selectedGroup.phone}</div>
                </div>
                <div className="log-entries">
                  {selectedEntries.map((r) => {
                    const isStatusChange = (r.memo || '').startsWith('【ステータス変更】')
                    return (
                      <div key={r.id} className={`log-entry ${isStatusChange ? 'log-status-change' : ''} ${r.status === 'pending' ? 'log-pending' : 'log-done'}`}>
                        <div className="log-entry-header">
                          <span className="log-date">{(r.created_at || '').replace('T', ' ').slice(0, 16)}</span>
                          <span className={`badge badge-${r.status}`}>
                            {r.status === 'pending' ? '未対応' : '対応済'}
                          </span>
                        </div>
                        {!isStatusChange && <div className="log-assignee">担当: {r.assignee}</div>}
                        <div className={`log-memo ${isStatusChange ? 'log-memo-status' : ''}`}>{r.memo}</div>
                        {r.status === 'pending' && !isStatusChange && (
                          <button className="done-btn" onClick={() => handleDone(r.id)}>対応済みにする</button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </>
            ) : (
              <div className="log-empty">
                <div className="log-empty-icon">📋</div>
                <p>要対応リストから顧客を選択すると<br />対応ログが表示されます</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
