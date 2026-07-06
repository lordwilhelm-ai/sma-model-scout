export default async function handler(req, res) {
  const data = req.body;
  
  if(data.Status === 'Success'){
    // Save vote to database here
    console.log('Vote success:', data.ClientReference);
  }
  
  res.status(200).json({ status: 'received' });
}