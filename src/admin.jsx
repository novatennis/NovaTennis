import React from 'react'
import ReactDOM from 'react-dom/client'
import AppV2 from './src/nova-tennis'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppV2 adminMode={true} />
  </React.StrictMode>
)
