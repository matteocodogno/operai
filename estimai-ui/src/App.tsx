import EstimatorApp from './EstimatorApp'
import { EstimatorProvider } from './context/EstimatorContext'

const App = () => (
  <EstimatorProvider>
    <EstimatorApp />
  </EstimatorProvider>
)

export default App
