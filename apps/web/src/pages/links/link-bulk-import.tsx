import { useState, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Upload, FileText, AlertCircle, CheckCircle2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/use-toast';
import api from '@/lib/api';

interface BulkResult {
  total: number;
  created: number;
  errors: { row: number; error: string }[];
}

export default function LinkBulkImportPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUpload = async () => {
    if (!file || !projectId) return;
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const response = await api.post(`/api/projects/${projectId}/links/bulk`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const data = response.data?.data || response.data;
      setResult(data);
      toast({ title: `Created ${data.created} of ${data.total} links` });
    } catch {
      toast({ title: 'Upload failed', variant: 'destructive' });
    }
    setIsUploading(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Bulk Import Links</h1>
        <Button variant="outline" onClick={() => navigate(`/projects/${projectId}/links`)}>Back to Links</Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upload CSV</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>CSV File</Label>
            <div
              className="border-2 border-dashed rounded-lg p-8 text-center cursor-pointer hover:bg-muted/50 transition"
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
              {file ? (
                <div className="flex items-center justify-center gap-2">
                  <FileText className="h-5 w-5 text-primary" />
                  <span className="font-medium">{file.name}</span>
                  <Badge variant="secondary">{(file.size / 1024).toFixed(1)} KB</Badge>
                </div>
              ) : (
                <div>
                  <Upload className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">Click to upload CSV file</p>
                  <p className="text-xs text-muted-foreground mt-1">Required columns: longUrl. Optional: title, tags, iosUrl, androidUrl, ogTitle, ogDescription</p>
                </div>
              )}
            </div>
          </div>

          <Button onClick={handleUpload} disabled={!file || !projectId || isUploading} className="w-full">
            {isUploading ? 'Uploading...' : 'Import Links'}
          </Button>
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <CardTitle>Import Results</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-4 mb-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-5 w-5 text-green-600" />
                <span className="font-medium">{result.created} created</span>
              </div>
              {result.errors.length > 0 && (
                <div className="flex items-center gap-2">
                  <AlertCircle className="h-5 w-5 text-red-600" />
                  <span className="font-medium">{result.errors.length} errors</span>
                </div>
              )}
            </div>
            {result.errors.length > 0 && (
              <div className="space-y-1 max-h-60 overflow-y-auto">
                {result.errors.map((err, i) => (
                  <div key={i} className="text-sm text-red-600">
                    Row {err.row}: {err.error}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
