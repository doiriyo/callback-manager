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

function groupByCustomer(records) {
  const map = {}
  for (const r of records) {
    const phone = String(r.phone || '')
    const name = String(r.customer_name || '')
    const key = `${phone}::${name}`
    if (!map[key]) {
      map[key] = { key, phone, customer_name: name, entries: [] }
    }
    map[key].entries.push(r)
  }
  return Object.values(map)
}

export default function App() {
  const [operatorName, setOperatorName] = useState(() => {
    // URLパラメータからの自動ログイン（Electron iframe経由）
    const params = new URLSearchParams(window.location.search)
    const urlOperator = params.get('operator')
    if (urlOperator) {
      saveSession(urlOperator)
      return urlOperator
    }
    return loadSession() || ''
  })
  const [loginInput, setLoginInput] = useState('')
  const isLoggedIn = !!operatorName

  const [records, setRecords] = useState([])
  const [filterPending, setFilterPending] = useState(true)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [selectedKey, setSelectedKey] = useState(null)

  // Form state
  const [phone, setPhone] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [memo, setMemo] = useState('')

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
    if (!isLoggedIn) return
    loadRecords()
    const interval = setInterval(loadRecords, 10000)
    return () => clearInterval(interval)
  }, [isLoggedIn, loadRecords])

  const handleSubmit = async (e) => {
    e.preventDefault()
    setSubmitting(true)

    const tempId = String(Date.now())
    const now = new Date().toISOString()

    // 楽観的UI更新: 即座にローカルstateに追加
    setRecords((prev) => [...prev, {
      id: tempId,
      phone,
      customer_name: customerName,
      assignee: operatorName,
      memo,
      created_at: now,
      status: 'pending',
      updated_at: now,
    }])

    const submitPhone = phone
    const submitName = customerName
    const submitMemo = memo
    setPhone('')
    setCustomerName('')
    setMemo('')
    setSubmitting(false)

    // バックグラウンドでGASに送信
    gasPost({
      action: 'add_callback',
      phone: submitPhone,
      customer_name: submitName,
      assignee: operatorName,
      memo: submitMemo,
    }).catch(() => {})
  }

  const handleDone = async (id) => {
    // 楽観的UI更新: 即座にステータスを変更 + ログエントリを仮追加
    const now = new Date().toISOString()
    setRecords((prev) => {
      const target = prev.find((r) => r.id === id)
      const updated = prev.map((r) => r.id === id ? { ...r, status: 'done', updated_at: now } : r)
      if (target) {
        updated.push({
          id: String(Date.now()),
          phone: target.phone,
          customer_name: target.customer_name,
          assignee: '',
          memo: `【ステータス変更】対応済みに変更（${operatorName}）`,
          created_at: now,
          status: 'done',
          updated_at: now,
        })
      }
      return updated
    })

    // バックグラウンドでGASに送信
    gasPost({ action: 'update_callback', id, status: 'done', operator: operatorName }).catch(() => {})
  }

  // グループ化 & フィルタリング
  const groups = groupByCustomer(records)
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
  const selectedGroup = selectedKey ? groups.find((g) => g.key === selectedKey) : null
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
          <h1>TWC電話応対マネージャー</h1>
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
        <h1>TWC電話応対マネージャー</h1>
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
              <input type="tel" placeholder="電話番号" value={phone} onChange={(e) => setPhone(e.target.value)} required />
              <input type="text" placeholder="顧客名" value={customerName} onChange={(e) => setCustomerName(e.target.value)} required />
              <textarea placeholder="用件メモ" value={memo} onChange={(e) => setMemo(e.target.value)} required rows={3} />
              <button type="submit" className="btn-primary" disabled={submitting}>
                {submitting ? '登録中...' : '登録する'}
              </button>
            </form>
            <div className="templates">
              <div className="templates-label">テンプレート</div>
              {[
                `電話したが不在でした。折り返しがあれば${operatorName}まで。`,
                'の件で電話しました。',
                `折り返しがあれば${operatorName}まで。`,
              ].map((t, i) => (
                <button key={i} type="button" className="template-btn" onClick={() => setMemo((prev) => prev ? prev + t : t)}>
                  {t}
                </button>
              ))}
            </div>
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
                const isSelected = selectedKey === g.key
                const hasPending = pendingCount > 0
                return (
                  <div
                    key={g.phone}
                    className={`group-item ${isSelected ? 'selected' : ''} ${hasPending ? 'has-pending' : 'all-done'}`}
                    onClick={() => setSelectedKey(isSelected ? null : g.key)}
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
                  <div className="log-header-info">
                    <div className="log-phone">{selectedGroup.phone}</div>
                    <button className="btn-reuse" onClick={() => { setPhone(selectedGroup.phone); setCustomerName(selectedGroup.customer_name); }}>
                      この連絡先で新規追加
                    </button>
                  </div>
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
