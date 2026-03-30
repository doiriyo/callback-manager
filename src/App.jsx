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

async function fetchCallbacks(status) {
  const body = { action: 'get_callbacks', api_key: GAS_API_KEY }
  if (status) body.status = status
  const res = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(body),
  })
  const data = await res.json()
  return data.records || []
}

function toLocalDatetime(date) {
  const d = date || new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export default function App() {
  const [records, setRecords] = useState([])
  const [filterPending, setFilterPending] = useState(true)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  // Form state
  const [phone, setPhone] = useState('')
  const [customerName, setCustomerName] = useState('')
  const [assignee, setAssignee] = useState('')
  const [memo, setMemo] = useState('')
  const [datetime, setDatetime] = useState(toLocalDatetime())

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
      // Reset form
      setPhone('')
      setCustomerName('')
      setAssignee('')
      setMemo('')
      setDatetime(toLocalDatetime())
      // Wait briefly for GAS to process, then reload
      setTimeout(loadRecords, 1500)
    } catch (e) {
      console.error('登録エラー:', e)
    } finally {
      setSubmitting(false)
    }
  }

  const handleDone = async (id) => {
    try {
      await gasPost({
        action: 'update_callback',
        id,
        status: 'done',
      })
      setTimeout(loadRecords, 1500)
    } catch (e) {
      console.error('更新エラー:', e)
    }
  }

  // Filtering
  const filtered = records.filter((r) => {
    if (filterPending && r.status !== 'pending') return false
    if (search) {
      const q = search.toLowerCase()
      const matchPhone = String(r.phone || '').toLowerCase().includes(q)
      const matchName = String(r.customer_name || '').toLowerCase().includes(q)
      if (!matchPhone && !matchName) return false
    }
    return true
  })

  const pendingCount = records.filter((r) => r.status === 'pending').length
  const todayStr = new Date().toISOString().slice(0, 10)
  const todayCount = records.filter((r) => (r.created_at || '').slice(0, 10) === todayStr).length

  return (
    <div className="container">
      <h1>コールバック管理</h1>

      {/* サマリー */}
      <div className="summary">
        <div className="card pending-card">
          <div className="card-value">{pendingCount}</div>
          <div className="card-label">未対応</div>
        </div>
        <div className="card today-card">
          <div className="card-value">{todayCount}</div>
          <div className="card-label">本日登録</div>
        </div>
      </div>

      {/* 新規登録フォーム */}
      <form className="form" onSubmit={handleSubmit}>
        <h2>新規登録</h2>
        <input
          type="tel"
          placeholder="電話番号 *"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          required
        />
        <input
          type="text"
          placeholder="顧客名 *"
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          required
        />
        <input
          type="text"
          placeholder="担当者名 *"
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          required
        />
        <textarea
          placeholder="用件メモ *"
          value={memo}
          onChange={(e) => setMemo(e.target.value)}
          required
          rows={3}
        />
        <input
          type="datetime-local"
          value={datetime}
          onChange={(e) => setDatetime(e.target.value)}
        />
        <button type="submit" disabled={submitting}>
          {submitting ? '登録中...' : '登録する'}
        </button>
      </form>

      {/* コールバック一覧 */}
      <div className="list-section">
        <h2>コールバック一覧</h2>
        <div className="list-controls">
          <div className="filter-toggle">
            <button
              className={filterPending ? 'active' : ''}
              onClick={() => setFilterPending(true)}
            >
              未対応のみ
            </button>
            <button
              className={!filterPending ? 'active' : ''}
              onClick={() => setFilterPending(false)}
            >
              全件
            </button>
          </div>
          <input
            type="text"
            className="search-input"
            placeholder="電話番号・顧客名で検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {loading && records.length === 0 && <p className="loading">読み込み中...</p>}

        {filtered.length === 0 && !loading && (
          <p className="empty">該当するレコードがありません</p>
        )}

        <div className="records">
          {filtered.map((r) => (
            <div
              key={r.id}
              className={`record ${r.status === 'pending' ? 'record-pending' : 'record-done'}`}
            >
              <div className="record-header">
                <span className="record-customer">{r.customer_name}</span>
                <span className={`badge badge-${r.status}`}>
                  {r.status === 'pending' ? '未対応' : '対応済'}
                </span>
              </div>
              <div className="record-phone">{r.phone}</div>
              <div className="record-meta">
                <span>担当: {r.assignee}</span>
                <span>{(r.created_at || '').replace('T', ' ').slice(0, 16)}</span>
              </div>
              <div className="record-memo">{r.memo}</div>
              {r.status === 'pending' && (
                <button className="done-btn" onClick={() => handleDone(r.id)}>
                  対応済みにする
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
